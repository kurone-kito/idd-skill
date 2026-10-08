import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The F4 pre-removal submodule probe, as the four files that carry it
// print it: two distributed copies and their generated mirrors. See
// kurone-kito/idd-skill#3855.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDD_MERGE_FILE =
  'idd-template/.github/instructions/idd-merge.instructions.md';
const PROBE_FILES = [
  IDD_MERGE_FILE,
  '.github/instructions/idd-merge.instructions.md',
  'idd-template/docs/idd-resume-detail.md',
  'docs/idd-resume-detail.md',
];

// A git-config-file-safe null-device path, as in
// tests/worktree-guard-hook.test.mts.
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Fixture git processes never read the ambient git configuration, so the
 * result does not depend on the developer's own identity or settings.
 */
function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
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
  env.GIT_AUTHOR_NAME = 'probe fixture';
  env.GIT_AUTHOR_EMAIL = 'probe@example.invalid';
  env.GIT_COMMITTER_NAME = 'probe fixture';
  env.GIT_COMMITTER_EMAIL = 'probe@example.invalid';
  return env;
}

/** Run git in a fixture repository and return its trimmed stdout. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

/** Create and commit one file in a fixture repository. */
function commitFile(repo: string, name: string, content: string): void {
  writeFileSync(join(repo, name), content);
  git(repo, ['add', name]);
  git(repo, ['commit', '-q', '-m', `add ${name}`]);
}

/** Read the probe's fenced block from one file, de-indented. */
function extractProbe(relativePath: string): string {
  const lines = readFileSync(join(REPO_ROOT, relativePath), 'utf8').split('\n');
  const probeIndex = lines.findIndex((line) =>
    line.includes('submodule foreach --recursive'),
  );
  assert.notEqual(probeIndex, -1, `${relativePath} has no probe`);

  let open = probeIndex;
  while (open >= 0 && !/^\s*```sh\s*$/.test(lines[open] ?? '')) {
    open -= 1;
  }
  assert.notEqual(open, -1, `${relativePath}: probe is outside a fence`);
  const fenceIndent = /^(\s*)/.exec(lines[open] ?? '')?.[1] ?? '';

  const body: string[] = [];
  for (let index = open + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '```') {
      return body
        .map((bodyLine) => bodyLine.slice(fenceIndent.length))
        .join('\n');
    }
    body.push(line);
  }
  assert.fail(`${relativePath}: probe fence is never closed`);
}

/**
 * Build a superproject with one submodule committed on `main`, and return
 * both paths. Each case builds its own pair, so no state leaks between
 * cases.
 */
function makeSuperproject(): { superRepo: string; subRepo: string } {
  const root = mkdtempSync(join(tmpdir(), 'f4-submodule-probe-'));
  tempRoots.push(root);

  const subRepo = join(root, 'sub-origin');
  mkdirSync(subRepo);
  git(subRepo, ['init', '-q', '-b', 'main']);
  git(subRepo, ['commit', '-q', '--allow-empty', '-m', 'init']);

  const superRepo = join(root, 'super');
  mkdirSync(superRepo);
  git(superRepo, ['init', '-q', '-b', 'main']);
  git(superRepo, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    subRepo,
    'sub',
  ]);
  git(superRepo, ['commit', '-q', '-m', 'add submodule']);

  return { superRepo, subRepo: join(superRepo, 'sub') };
}

/**
 * Run the probe with `<path>` replaced by the superproject, through `sh`,
 * as F4 runs it. Return the exit status without throwing.
 */
function runProbe(probe: string, superRepo: string): number | null {
  const command = probe.replace('<path>', `'${superRepo}'`);
  const result = spawnSync('sh', ['-c', command], {
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return result.status;
}

/**
 * Assert the probe fails with a real non-zero exit status. A null status
 * means the shell was killed by a signal, which is not a clean failure.
 */
function assertProbeFails(probe: string, superRepo: string): void {
  const status = runProbe(probe, superRepo);
  assert.equal(typeof status, 'number', 'the probe was killed by a signal');
  assert.notEqual(status, 0);
}

test('the probe is one line and identical across the four files', () => {
  const probes = PROBE_FILES.map((file) => extractProbe(file));

  for (const [index, probe] of probes.entries()) {
    assert.equal(
      probe.includes('\n'),
      false,
      `${PROBE_FILES[index]}: probe has a newline`,
    );
  }
  for (const probe of probes.slice(1)) {
    assert.equal(probe, probes[0]);
  }
});

test('a healthy submodule on a branch exits 0', () => {
  const probe = extractProbe(IDD_MERGE_FILE);
  const { superRepo, subRepo } = makeSuperproject();
  // `git submodule add` leaves the submodule detached, so create a local
  // branch and confirm HEAD is symbolic before probing it.
  git(subRepo, ['checkout', '-q', '-b', 'work']);
  assert.equal(git(subRepo, ['symbolic-ref', '-q', 'HEAD']), 'refs/heads/work');

  assert.equal(runProbe(probe, superRepo), 0);
});

test('a healthy submodule on a detached HEAD still exits 0', () => {
  const probe = extractProbe(IDD_MERGE_FILE);
  const { superRepo, subRepo } = makeSuperproject();
  git(subRepo, ['checkout', '-q', '--detach']);

  assert.equal(runProbe(probe, superRepo), 0);
});

test('a failing git status makes the probe exit non-zero', () => {
  const probe = extractProbe(IDD_MERGE_FILE);
  const { superRepo, subRepo } = makeSuperproject();

  // A local commit makes the HEAD tree a loose object; deleting that file
  // leaves HEAD pointing at a tree git cannot read. A file is needed
  // because the empty tree is never stored as a loose object.
  commitFile(subRepo, 'local.txt', 'local work\n');
  const treeSha = git(subRepo, ['rev-parse', 'HEAD^{tree}']);
  const gitDir = resolve(subRepo, git(subRepo, ['rev-parse', '--git-dir']));
  rmSync(join(gitDir, 'objects', treeSha.slice(0, 2), treeSha.slice(2)));

  assertProbeFails(probe, superRepo);
});

test('a failing git stash list makes the probe exit non-zero', () => {
  const probe = extractProbe(IDD_MERGE_FILE);
  const { superRepo, subRepo } = makeSuperproject();

  // Create a stash entry first, so the listing has something to parse
  // when the invalid log.date makes it fail.
  writeFileSync(join(subRepo, 'scratch.txt'), 'scratch\n');
  git(subRepo, ['stash', 'push', '-q', '--include-untracked', '-m', 'probe']);
  assert.match(git(subRepo, ['stash', 'list']), /probe/);
  git(subRepo, ['config', 'log.date', 'bogus']);

  assertProbeFails(probe, superRepo);
});
