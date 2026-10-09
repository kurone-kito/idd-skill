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
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHECK_STRAY_COMMIT_CLOSES_FLAG_SPEC,
  checkStrayCommits,
} from '../src/scripts/check-stray-commit-closes.mts';
import { stubExecutable } from './test-utils.mts';

const ENTRY = fileURLToPath(
  new URL('../src/scripts/check-stray-commit-closes.mts', import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// `node:os`'s `devNull` is `\\.\nul` on win32, which Git for Windows rejects as
// a GIT_CONFIG_GLOBAL value; the bare `NUL` is what it accepts.
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

// Fixture git processes must never read the developer's config or an ambient
// GIT_DIR. The helper spawns git with this process's env, so scrub it here.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_CONFIG')) {
    delete process.env[key];
  }
}
for (const key of [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
]) {
  delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = GIT_NULL_DEVICE;

// The only commit message in the repository that names #169 with a closing
// keyword. The test below asserts that no other file carries it.
const STRAY_MESSAGE = 'Fix the parser\n\nCloses #169 in the old tracker.';
const STRAY_PHRASE = 'Closes #169 in the old tracker';

// `gh` stands in for the default-branch query. `STUB_GH_MODE=fail` makes it
// fail, so one case can show a default-branch read that cannot run.
const restoreGh = stubExecutable(
  'gh',
  [
    "if (process.env.STUB_GH_MODE === 'fail') {",
    "  process.stderr.write('gh: no network\\n');",
    '  process.exit(1);',
    '}',
    "process.stdout.write('main\\n');",
  ].join('\n'),
);
after(restoreGh);

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commit(cwd: string, message: string): string {
  git(
    cwd,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    message,
  );
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

/** A work repository on `main` whose `origin` is a bare repository that
 * already has `main`, so `origin/main` exists. */
function makeRepo(): { work: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), 'idd-stray-check-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'Fixture');
  git(work, 'config', 'user.email', 'fixture@example.invalid');
  git(work, 'config', 'commit.gpgsign', 'false');
  commit(work, 'base');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  return { work, origin };
}

/** The repository's own `origin` replaced by a path that does not exist. */
function breakOrigin(work: string): void {
  git(work, 'remote', 'set-url', 'origin', join(work, 'no-such-remote'));
}

function writeConfig(work: string, body: string): void {
  mkdirSync(join(work, '.github', 'idd'), { recursive: true });
  writeFileSync(join(work, '.github', 'idd', 'config.json'), body);
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the helper from `cwd`. `IDD_CLOSING_ISSUES` is cleared unless `env`
 * sets it, so no case inherits the developer's variable. */
function check(
  cwd: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
): Run {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.IDD_CLOSING_ISSUES;
  Object.assign(childEnv, env);
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    env: childEnv,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** A feature branch `issue/3876-example` with one commit per message. */
function featureWithCommits(
  work: string,
  messages: readonly string[],
  branch = 'issue/3876-example',
): string[] {
  git(work, 'checkout', '-q', '-b', branch);
  return messages.map((message) => commit(work, message));
}

test('reports a stray closing reference with exit 1, stdout only', () => {
  const { work } = makeRepo();
  const [sha] = featureWithCommits(work, [STRAY_MESSAGE]);
  const run = check(work);
  assert.equal(run.status, 1);
  assert.equal(run.stderr, '');
  assert.match(
    run.stdout,
    new RegExp(`stray closing reference: commit ${sha} names #169`),
  );
  assert.match(run.stdout, /IDD_CLOSING_ISSUES/);
  assert.match(run.stdout, /--closing-issues/);
});

test('accepts a flagged list in both forms', () => {
  const { work } = makeRepo();
  featureWithCommits(work, [STRAY_MESSAGE]);
  assert.equal(check(work, ['--closing-issues', '3876,169']).status, 0);
  assert.equal(check(work, ['--closing-issues=3876,169']).status, 0);
});

test('accepts the variable when the flag is absent', () => {
  const { work } = makeRepo();
  featureWithCommits(work, [STRAY_MESSAGE]);
  const run = check(work, [], { IDD_CLOSING_ISSUES: '3876,169' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'no stray closing references in 1 commits\n');
});

test('the flag wins over the variable', () => {
  const { work } = makeRepo();
  featureWithCommits(work, [STRAY_MESSAGE]);
  assert.equal(
    check(work, ['--closing-issues', '3876,169'], {
      IDD_CLOSING_ISSUES: '3876',
    }).status,
    0,
  );
  assert.equal(
    check(work, ['--closing-issues', '3876'], {
      IDD_CLOSING_ISSUES: '3876,169',
    }).status,
    1,
  );
});

test('a commit closing only the branch issue passes', () => {
  const { work } = makeRepo();
  featureWithCommits(work, ['Closes #3876']);
  assert.equal(check(work).status, 0);
});

test('a mention of 169 without a closing keyword passes', () => {
  const { work } = makeRepo();
  featureWithCommits(work, ['See #169 for the earlier discussion']);
  assert.equal(check(work).status, 0);
});

test('a merge commit whose body closes 169 is refused', () => {
  const { work } = makeRepo();
  featureWithCommits(work, ['Side work']);
  git(work, 'checkout', '-q', '-b', 'side', 'HEAD~0');
  commit(work, 'Side note');
  git(work, 'checkout', '-q', 'issue/3876-example');
  git(
    work,
    '-c',
    'commit.gpgsign=false',
    'merge',
    '-q',
    '--no-ff',
    '-m',
    'Merge side work\n\nCloses #169 from the side branch.',
    'side',
  );
  const run = check(work);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /names #169/);
});

test('a record separator byte in a message keeps the stray under its own sha', () => {
  const { work } = makeRepo();
  const [sha] = featureWithCommits(work, [
    'Split here\u001e and then\n\nCloses #169 in the old tracker.',
  ]);
  const run = check(work);
  assert.equal(run.status, 1);
  assert.match(
    run.stdout,
    new RegExp(`stray closing reference: commit ${sha} names #169`),
  );
});

test('a commit already on origin/main is not reported', () => {
  const { work } = makeRepo();
  commit(work, STRAY_MESSAGE);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'issue/3876-example', 'origin/main');
  commit(work, 'Clean follow-up');
  const run = check(work);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'no stray closing references in 1 commits\n');
});

test('a detached HEAD with a flag does not need a branch number', () => {
  const { work } = makeRepo();
  commit(work, 'Closes #3876');
  git(work, 'checkout', '-q', '--detach');
  const run = check(work, ['--closing-issues', '3876']);
  assert.equal(run.status, 0);
});

test('a detached HEAD without a list is skipped', () => {
  const { work } = makeRepo();
  git(work, 'checkout', '-q', '--detach');
  const run = check(work);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'skipped: branch is not an issue branch\n');
});

for (const branch of ['issue/03876-x', 'issue/0-x', 'issue/3876']) {
  test(`skips ${branch} as not an issue branch`, () => {
    const { work } = makeRepo();
    featureWithCommits(work, [STRAY_MESSAGE], branch);
    const run = check(work);
    assert.equal(run.status, 0);
    assert.equal(run.stdout, 'skipped: branch is not an issue branch\n');
  });
}

test('a development branch other than the default is skipped before any fetch', () => {
  const { work } = makeRepo();
  featureWithCommits(work, [STRAY_MESSAGE]);
  writeConfig(work, JSON.stringify({ developmentBranch: 'release' }));
  breakOrigin(work);
  const run = check(work);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'skipped: non-default development branch release\n');
});

for (const value of ['refs/heads/x', 'release branch', '', null]) {
  test(`refuses developmentBranch ${JSON.stringify(value)}`, () => {
    const { work } = makeRepo();
    featureWithCommits(work, [STRAY_MESSAGE]);
    writeConfig(work, JSON.stringify({ developmentBranch: value }));
    assert.equal(check(work).status, 1);
  });
}

test('a missing config file leaves the field unset', () => {
  const { work } = makeRepo();
  featureWithCommits(work, ['Closes #3876']);
  assert.equal(check(work).status, 0);
});

for (const [label, body] of [
  ['invalid JSON', '{ not json'],
  ['an array root', '[]'],
  ['a string root', '"x"'],
] as const) {
  test(`refuses a config with ${label}`, () => {
    const { work } = makeRepo();
    featureWithCommits(work, ['Closes #3876']);
    writeConfig(work, body);
    assert.equal(check(work).status, 1);
  });
}

test('a failed default-branch read exits 1, with or without a development branch', () => {
  for (const config of [
    undefined,
    JSON.stringify({ developmentBranch: 'release' }),
  ]) {
    const { work } = makeRepo();
    featureWithCommits(work, ['Closes #3876']);
    if (config !== undefined) {
      writeConfig(work, config);
    }
    const run = check(work, [], { STUB_GH_MODE: 'fail' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /could not read the default branch/);
  }
});

test('a fetch failure exits 1 with the retry text', () => {
  const { work } = makeRepo();
  featureWithCommits(work, ['Closes #3876']);
  breakOrigin(work);
  const run = check(work);
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /could not fetch origin\/main; check the network and retry/,
  );
});

test('an origin/main absent after fetch exits 1', () => {
  const { work, origin } = makeRepo();
  git(work, 'remote', 'set-url', 'origin', origin);
  git(
    work,
    'config',
    'remote.origin.fetch',
    '+refs/heads/other:refs/remotes/origin/other',
  );
  // The push in makeRepo created origin/main; drop it so only the fetch can
  // bring it back, and the configured refspec does not map main.
  git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
  git(work, 'checkout', '-q', '-b', 'issue/3876-example');
  commit(work, 'Closes #3876');
  assert.throws(() => git(work, 'rev-parse', '--verify', 'origin/main'));
  const run = check(work);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /origin\/main is missing after fetch/);
});

test('an unborn HEAD exits 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-stray-check-unborn-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  assert.equal(check(root).status, 1);
});

test('HEAD equal to origin/main has no commits to check', () => {
  const { work } = makeRepo();
  git(work, 'checkout', '-q', '-b', 'issue/3876-example');
  const run = check(work);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'no stray closing references in 0 commits\n');
});

test('reports checkStrayCommits results for a fixed commit list', () => {
  const sha = 'a'.repeat(40);
  const result = checkStrayCommits({
    expectedIssues: [3876],
    commits: [{ sha, message: STRAY_MESSAGE }],
  });
  assert.deepEqual(result, { strays: [{ sha, issue: 169 }] });
});

test('the stray fixture phrase appears in no other file', () => {
  const found = git(REPO_ROOT, 'grep', '-l', '-F', '--untracked', STRAY_PHRASE)
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(found, ['tests/check-stray-commit-closes.test.mts']);
});

test('pre-push-validate ends with the helper, and its manifest row matches', () => {
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, '.github', 'idd', 'config.json'), 'utf8'),
  );
  const command: string = config.commands['pre-push-validate'];
  assert.equal(
    command.split(' && ').at(-1),
    'node scripts/check-stray-commit-closes.mjs',
  );
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'audit', 'sync-manifest.json'), 'utf8'),
  );
  const from = '| **pre-push-validate** | `{{PRE_PUSH_VALIDATE_COMMANDS}}` |';
  const replacements = manifest.syncPairs.flatMap(
    (pair: { replacements?: { from: string; to: string }[] }) =>
      pair.replacements ?? [],
  );
  const row = replacements.find(
    (replacement: { from: string }) => replacement.from === from,
  );
  assert.equal(row.to, `| **pre-push-validate** | \`${command}\` |`);
});

test('the flag spec lists exactly the documented flags', () => {
  assert.deepEqual(Object.keys(CHECK_STRAY_COMMIT_CLOSES_FLAG_SPEC).sort(), [
    '--closing-issues',
    '--help',
  ]);
});

test('--help prints the usage to stdout and exits 0', () => {
  const { work } = makeRepo();
  const run = check(work, ['--help']);
  assert.equal(run.status, 0);
  assert.match(
    run.stdout,
    /^usage: node scripts\/check-stray-commit-closes\.mjs/,
  );
  assert.equal(run.stderr, '');
});

test('an unknown argument exits 2', () => {
  const { work } = makeRepo();
  assert.equal(check(work, ['--bogus']).status, 2);
});

test('a repeated list flag exits 2', () => {
  const { work } = makeRepo();
  featureWithCommits(work, ['Closes #3876']);
  assert.equal(
    check(work, ['--closing-issues', '3876', '--closing-issues', '3876'])
      .status,
    2,
  );
  assert.equal(
    check(work, ['--closing-issues=3876', '--closing-issues=3876']).status,
    2,
  );
});

test('a whitespace-only variable exits 2', () => {
  const { work } = makeRepo();
  featureWithCommits(work, ['Closes #3876']);
  assert.equal(check(work, [], { IDD_CLOSING_ISSUES: '   ' }).status, 2);
});

test('an empty variable behaves as unset', () => {
  const { work } = makeRepo();
  featureWithCommits(work, [STRAY_MESSAGE]);
  assert.equal(check(work, [], { IDD_CLOSING_ISSUES: '' }).status, 1);
});

const MALFORMED_LISTS: readonly [string, readonly string[]][] = [
  ['an empty value', ['--closing-issues', '']],
  ['an empty equals value', ['--closing-issues=']],
  ['a flag with no value', ['--closing-issues']],
  ['a list without the branch number', ['--closing-issues', '169']],
  ['zero', ['--closing-issues', '0']],
  ['a trailing letter', ['--closing-issues', '1x']],
  ['a leading zero', ['--closing-issues', '03876']],
  ['NaN', ['--closing-issues', 'NaN']],
  ['a negative number', ['--closing-issues', '-5']],
  ['Infinity', ['--closing-issues', 'Infinity']],
  ['a space after the comma', ['--closing-issues', '3876, 169']],
];

for (const [label, args] of MALFORMED_LISTS) {
  test(`exits 2 for ${label}`, () => {
    const { work } = makeRepo();
    featureWithCommits(work, [STRAY_MESSAGE]);
    assert.equal(check(work, args).status, 2);
  });
}
