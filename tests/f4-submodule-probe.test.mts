import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureEnv } from './test-utils.mts';

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

// The shared fixtureEnv() sets no commit identity, so the fixture commits
// spread these in at each call site.
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'probe fixture',
  GIT_AUTHOR_EMAIL: 'probe@example.invalid',
  GIT_COMMITTER_NAME: 'probe fixture',
  GIT_COMMITTER_EMAIL: 'probe@example.invalid',
};

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Run git in a fixture repository and return its trimmed stdout. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...fixtureEnv(), ...FIXTURE_IDENTITY },
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
  // The apostrophe in the prefix checks that the path is not spliced into
  // the shell command unquoted.
  const root = mkdtempSync(join(tmpdir(), "f4-submodule-probe-it's-"));
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
 * as F4 runs it. Return the exit status and stdout without throwing.
 */
function runProbe(
  probe: string,
  superRepo: string,
): { status: number | null; stdout: string } {
  // The superproject is passed as a positional argument, not spliced into
  // the command, so a path containing quotes cannot change the command.
  const command = probe.replace('<path>', '"$1"');
  const result = spawnSync('sh', ['-c', command, 'probe', superRepo], {
    env: { ...fixtureEnv(), ...FIXTURE_IDENTITY },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return { status: result.status, stdout: result.stdout };
}

/**
 * Assert the probe fails with a real non-zero exit status. A null status
 * means the shell was killed by a signal, which is not a clean failure.
 */
function assertProbeFails(probe: string, superRepo: string): void {
  const { status } = runProbe(probe, superRepo);
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

test('a healthy submodule on a branch exits 0 and prints its count', () => {
  const probe = extractProbe(IDD_MERGE_FILE);
  const { superRepo, subRepo } = makeSuperproject();
  // `git submodule add` leaves the submodule detached, so create a local
  // branch and confirm HEAD is symbolic before probing it.
  git(subRepo, ['checkout', '-q', '-b', 'work']);
  assert.equal(git(subRepo, ['symbolic-ref', '-q', 'HEAD']), 'refs/heads/work');

  // A symbolic HEAD skips the trailing count, so only the unpushed count
  // from the second leg is printed.
  const { status, stdout } = runProbe(probe, superRepo);
  assert.equal(status, 0);
  assert.equal(stdout, "Entering 'sub'\n0\n");
});

test('a healthy submodule on a detached HEAD exits 0 and prints its counts', () => {
  const probe = extractProbe(IDD_MERGE_FILE);
  const { superRepo, subRepo } = makeSuperproject();
  git(subRepo, ['checkout', '-q', '--detach']);

  // A detached HEAD also prints the count of commits reachable from HEAD.
  const { status, stdout } = runProbe(probe, superRepo);
  assert.equal(status, 0);
  assert.equal(stdout, "Entering 'sub'\n0\n0\n");
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
