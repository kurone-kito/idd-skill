import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  type CommandResult,
  createReleaseTagDeps,
  parseRepositoryIdentity,
  type ReleaseTagDeps,
  type ReleaseTagInput,
  type ReleaseTagOutcome,
  type ReleaseTagRequest,
  type ReleaseTagRunner,
  runReleaseTag,
} from '../src/scripts/release-tag.mts';
import { trackTempDirectories } from './temp-fixtures.mts';
import { fixtureEnv } from './test-utils.mts';

// Real-git coverage of the release-tag core (#4523): a temporary bare
// `origin`, a seed clone that plays the maintainer who merged the bump pull
// request, and a primary clone the core runs in. Signing uses an ed25519 key
// generated here, never the operator's key. Git's global and system
// configuration are isolated by `fixtureEnv()`, and the `gh` reads are a fake
// inside the injected runner, so no test reaches GitHub or the network.

// Registered before the fixture cleanup, so it runs while the marker files
// still exist: `after` hooks run in the order they are registered.
after(() => {
  killMarkerPids();
});
const mkdtemp = trackTempDirectories();

const VERSION = '1.2.3';
const TAG = `v${VERSION}`;
const ISSUE = 4522;
const PULL_REQUEST = 4521;
const SLUG = 'github.com/fixture-owner/fixture-repo';
const EMAIL = 'release@example.invalid';
const IDENTITY = {
  GIT_AUTHOR_NAME: 'release fixture',
  GIT_AUTHOR_EMAIL: EMAIL,
  GIT_COMMITTER_NAME: 'release fixture',
  GIT_COMMITTER_EMAIL: EMAIL,
};
/** What the harness reports for `git --version` unless a test overrides it. */
const SUPPORTED_GIT_VERSION = 'git version 2.44.0\n';

/**
 * Whether the host git fails `git tag -s` when an SSH signer fails. Before
 * 2.44.0 it writes an unsigned tag instead, which the broken-signer case tests.
 */
const HOST_GIT_FAILS_A_FAILED_SSH_SIGN = (() => {
  const match = /^git version (\d+)\.(\d+)/u.exec(
    execFileSync('git', ['--version'], { encoding: 'utf8' }),
  );
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  return major > 2 || (major === 2 && minor >= 44);
})();

/** The process-tree fixtures need POSIX `ps` and `sh`. */
const SKIP_PROCESS_TREE = process.platform === 'win32';

/** PIDs a stub recorded; the `after` hook kills any still running here. */
const markerFiles: { file: string; root: string }[] = [];

function processArgs(pid: number): string | null {
  const result = spawnSync(
    'ps',
    ['-ww', '-o', 'stat=,args=', '-p', String(pid)],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) return null;
  const line = result.stdout.trim();
  if (line === '' || line.startsWith('Z')) return null;
  return line;
}

function isAlive(pid: number): boolean {
  return processArgs(pid) !== null;
}

function readPids(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\s+/u)
    .filter((value) => value !== '')
    .map(Number);
}

function killMarkerPids(): void {
  for (const { file, root } of markerFiles) {
    for (const pid of readPids(file)) {
      const args = processArgs(pid);
      // Only a process that still names this fixture: a reused PID is left.
      if (args === null || !args.includes(root)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}

interface Fixture {
  root: string;
  origin: string;
  seed: string;
  primary: string;
  key: string;
  allowed: string;
  env: NodeJS.ProcessEnv;
  /** The bump pull request's merge commit, at the tip of `main`. */
  sha: string;
  /** The commit before it. */
  base: string;
}

function git(
  fx: { env: NodeJS.ProcessEnv },
  cwd: string,
  args: string[],
): string {
  return execFileSync('git', args, {
    cwd,
    env: fx.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface ReleaseFiles {
  packageVersion?: string;
  iddVersion?: string;
  templateIddVersion?: string;
  changelog?: string;
}

function writeReleaseFiles(dir: string, files: ReleaseFiles = {}): void {
  mkdirSync(join(dir, '.github/idd'), { recursive: true });
  mkdirSync(join(dir, 'idd-template/.github/idd'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: files.packageVersion ?? VERSION }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, '.github/idd/config.json'),
    `${JSON.stringify(
      {
        iddVersion: files.iddVersion ?? VERSION,
        labels: { blockedByHumanLabelName: 'status:blocked-by-human' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, 'idd-template/.github/idd/config.json'),
    `${JSON.stringify({ iddVersion: files.templateIddVersion ?? VERSION }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    files.changelog ??
      `# Changelog\n\n## [Unreleased]\n\n## [${VERSION}] - 2026-10-19\n\n- Release.\n`,
  );
}

function makeFixture(files: ReleaseFiles = {}): Fixture {
  const root = mkdtemp(join(tmpdir(), 'release-tag-'));
  const scratch = join(root, 'tmp');
  mkdirSync(scratch);
  const env: NodeJS.ProcessEnv = {
    ...fixtureEnv(),
    ...IDENTITY,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  };
  delete env.SSH_AUTH_SOCK;
  delete env.GH_REPO;
  const fx = { env };
  const key = join(root, 'key');
  execFileSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', EMAIL, '-f', key],
    {
      env,
      stdio: 'ignore',
    },
  );
  const publicKey = readFileSync(`${key}.pub`, 'utf8')
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');
  const allowed = join(root, 'allowed_signers');
  writeFileSync(allowed, `${EMAIL} ${publicKey}\n`);

  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const primary = join(root, 'primary');
  git(fx, root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(fx, root, ['clone', '-q', origin, seed]);
  git(fx, seed, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(seed, 'README.md'), 'fixture\n');
  git(fx, seed, ['add', '-A']);
  git(fx, seed, ['commit', '-q', '-m', 'chore: start']);
  const base = git(fx, seed, ['rev-parse', 'HEAD']);
  writeReleaseFiles(seed, files);
  git(fx, seed, ['add', '-A']);
  git(fx, seed, ['commit', '-q', '-m', `chore(release): bump to ${VERSION}`]);
  const sha = git(fx, seed, ['rev-parse', 'HEAD']);
  git(fx, seed, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  git(fx, root, ['clone', '-q', origin, primary]);
  for (const repo of [seed, primary]) {
    git(fx, repo, ['config', 'gpg.format', 'ssh']);
    git(fx, repo, ['config', 'user.signingkey', key]);
  }
  return { root, origin, seed, primary, key, allowed, env, sha, base };
}

/** Write an executable `#!/bin/sh` stub under the fixture root. */
function writeStub(fx: Fixture, name: string, body: string): string {
  const path = join(fx.root, name);
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

interface GhState {
  issueState: string;
  labels: readonly string[];
  pullRequestState: string;
  mergeOid: string;
  defaultBranch: string;
}

function ok(stdout: string): CommandResult {
  return { status: 0, signal: null, stdout, stderr: '' };
}

/** The fake `gh`: only the three reads, each with its exact argument list. */
function fakeGh(args: readonly string[], state: GhState): CommandResult {
  if (args[0] === 'issue') {
    assert.deepEqual(args, [
      'issue',
      'view',
      String(ISSUE),
      '--repo',
      SLUG,
      '--json',
      'state,labels',
    ]);
    return ok(
      JSON.stringify({
        labels: state.labels.map((name) => ({ id: `L_${name}`, name })),
        state: state.issueState,
      }),
    );
  }
  if (args[0] === 'pr') {
    assert.deepEqual(args, [
      'pr',
      'view',
      String(PULL_REQUEST),
      '--repo',
      SLUG,
      '--json',
      'state,mergeCommit',
    ]);
    return ok(
      JSON.stringify({
        mergeCommit: { oid: state.mergeOid },
        state: state.pullRequestState,
      }),
    );
  }
  assert.deepEqual(args, [
    'repo',
    'view',
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ]);
  return ok(`${state.defaultBranch}\n`);
}

interface Harness {
  deps: ReleaseTagDeps;
  calls: ReleaseTagRequest[];
}

interface HarnessOptions {
  gh?: Partial<GhState>;
  timeBoundMs?: number;
  sharedWaitMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Replaces the real git runner for one request; return null to run it. */
  wrap?: (
    request: ReleaseTagRequest & { kind: 'git' },
    real: ReleaseTagRunner,
  ) => Promise<CommandResult | null>;
}

function harness(fx: Fixture, options: HarnessOptions = {}): Harness {
  const real = createReleaseTagDeps({
    env: options.env ?? fx.env,
    timeBoundMs: options.timeBoundMs ?? 60_000,
    sharedWaitMs: options.sharedWaitMs ?? 5_000,
    pollIntervalMs: 50,
  });
  const state: GhState = {
    issueState: 'OPEN',
    labels: ['release'],
    pullRequestState: 'MERGED',
    mergeOid: fx.sha,
    defaultBranch: 'main',
    ...options.gh,
  };
  const calls: ReleaseTagRequest[] = [];
  const run: ReleaseTagRunner = async (request) => {
    calls.push(request);
    if (request.kind === 'gh') {
      assert.equal(request.cwd, fx.primary);
      return fakeGh(request.args, state);
    }
    if (options.wrap !== undefined) {
      const replaced = await options.wrap(request, real.run);
      if (replaced !== null) return replaced;
    }
    // A supported version, so the scenarios do not depend on the host git;
    // the version-gate test overrides it through `wrap`.
    if (request.args[0] === '--version') return ok(SUPPORTED_GIT_VERSION);
    return await real.run(request);
  };
  return { deps: { ...real, run, ghRepositorySlug: () => SLUG }, calls };
}

function releaseInput(
  fx: Fixture,
  overrides: Partial<ReleaseTagInput> = {},
): ReleaseTagInput {
  return {
    operation: 'signed-annotated-tag',
    version: VERSION,
    mergeSha: fx.sha,
    pullRequest: PULL_REQUEST,
    issue: ISSUE,
    allowedSigners: fx.allowed,
    cwd: fx.primary,
    ...overrides,
  };
}

/** The git subcommand of a request, after any leading `-c key=value` pairs. */
function subcommand(args: readonly string[]): string | undefined {
  let index = 0;
  while (args[index] === '-c') index += 2;
  return args[index];
}

function gitCalls(
  calls: readonly ReleaseTagRequest[],
  name: string,
): ReleaseTagRequest[] {
  return calls.filter(
    (call) => call.kind === 'git' && subcommand(call.args) === name,
  );
}

function localTags(fx: Fixture): string[] {
  const out = git(fx, fx.primary, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/tags',
  ]);
  return out === '' ? [] : out.split('\n');
}

function remoteTags(fx: Fixture): string[] {
  const out = git(fx, fx.origin, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/tags',
  ]);
  return out === '' ? [] : out.split('\n');
}

function assertRefused(outcome: ReleaseTagOutcome, name: string): void {
  assert.equal(outcome.exitStatus, 1, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.decision, 'refused');
  assert.equal(
    outcome.report.refusal?.name,
    name,
    JSON.stringify(outcome.report.refusal),
  );
}

function assertNoWrites(calls: readonly ReleaseTagRequest[]): void {
  for (const sub of ['fetch', 'tag', 'push']) {
    assert.deepEqual(gitCalls(calls, sub), [], `no git ${sub} may run`);
  }
}

/** Sign `TAG` at `target` in `repo` and push it to origin. */
function pushSignedTag(
  fx: Fixture,
  repo: string,
  target: string,
  message = `release ${TAG}`,
): string {
  git(fx, repo, ['tag', '-s', '-m', message, TAG, target]);
  git(fx, repo, ['push', '-q', 'origin', `refs/tags/${TAG}:refs/tags/${TAG}`]);
  return git(fx, repo, ['rev-parse', `refs/tags/${TAG}`]);
}

test('a dry run is the default: it plans the tag and creates no tag ref and no push', async () => {
  const fx = makeFixture();
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.mode, 'dry-run');
  assert.equal(outcome.report.decision, 'create');
  assert.deepEqual(
    outcome.report.preconditions.map((item) => [item.name, item.status]),
    [
      ['input', 'passed'],
      ['repository', 'passed'],
      ['release-issue', 'passed'],
      ['bump-pull-request', 'passed'],
      ['default-branch', 'passed'],
      ['merge-commit', 'passed'],
      ['package-version', 'passed'],
      ['idd-version', 'passed'],
      ['template-idd-version', 'passed'],
      ['changelog-heading', 'passed'],
      ['remote-tag', 'passed'],
      ['local-tag', 'passed'],
    ],
  );
  assert.deepEqual(
    outcome.report.effects.map((item) => [item.name, item.status]),
    [
      ['create-tag', 'planned'],
      ['signature-check', 'planned'],
      ['push-tag', 'planned'],
      ['post-push-check', 'planned'],
    ],
  );
  assert.deepEqual(gitCalls(calls, 'tag'), []);
  assert.deepEqual(gitCalls(calls, 'push'), []);
  assert.deepEqual(localTags(fx), []);
  assert.deepEqual(remoteTags(fx), []);
  assert.equal(outcome.report.pushed, false);
  assert.equal(outcome.report.created, false);
});

test('the report has exactly the documented keys', async () => {
  const fx = makeFixture();
  const { deps } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx), deps);
  assert.deepEqual(Object.keys(outcome.report).sort(), [
    'created',
    'decision',
    'effects',
    'found',
    'mode',
    'operation',
    'peeledCommit',
    'preconditions',
    'pushAttempts',
    'pushed',
    'refusal',
    'tag',
    'tagObject',
  ]);
  const refused = await runReleaseTag(
    releaseInput(fx, { version: 'bad' }),
    deps,
  );
  assert.deepEqual(Object.keys(refused.report.refusal ?? {}).sort(), [
    'detail',
    'name',
    'processes',
  ]);
});

test('an unknown operation is refused before any git or gh command runs', async () => {
  const fx = makeFixture();
  const { deps, calls } = harness(fx);
  for (const operation of [
    'lightweight-tag',
    'signed-annotated-tag ',
    '',
    undefined,
    1,
  ]) {
    const outcome = await runReleaseTag(releaseInput(fx, { operation }), deps);
    assertRefused(outcome, 'unknown-operation');
    assert.equal(outcome.report.operation, null);
  }
  assert.deepEqual(calls, []);
});

test('each malformed input is refused by name before any command runs', async () => {
  const fx = makeFixture();
  const { deps, calls } = harness(fx);
  const cases: [Partial<ReleaseTagInput>, string][] = [
    [{ version: '1.2' }, 'invalid-version'],
    [{ version: 'v1.2.3' }, 'invalid-version'],
    [{ version: '01.2.3' }, 'invalid-version'],
    [{ version: '1.2.3-rc.1' }, 'invalid-version'],
    [{ version: 123 }, 'invalid-version'],
    [{ mergeSha: fx.sha.toUpperCase() }, 'invalid-merge-sha'],
    [{ mergeSha: fx.sha.slice(0, 12) }, 'invalid-merge-sha'],
    [{ mergeSha: `${fx.sha}0` }, 'invalid-merge-sha'],
    [{ pullRequest: 0 }, 'invalid-pull-request'],
    [{ pullRequest: -1 }, 'invalid-pull-request'],
    [{ pullRequest: 1.5 }, 'invalid-pull-request'],
    [{ pullRequest: '4521' }, 'invalid-pull-request'],
    [{ issue: 0 }, 'invalid-issue'],
    [{ issue: Number.NaN }, 'invalid-issue'],
    [{ issue: '4522' }, 'invalid-issue'],
    [{ allowedSigners: '' }, 'invalid-allowed-signers'],
    [{ allowedSigners: 'allowed_signers' }, 'invalid-allowed-signers'],
    [{ allowedSigners: join(fx.root, 'missing') }, 'invalid-allowed-signers'],
    [{ allowedSigners: fx.root }, 'invalid-allowed-signers'],
    [{ allowedSigners: `${fx.allowed}\n` }, 'invalid-allowed-signers'],
    [{ apply: 'yes' }, 'invalid-apply'],
    [{ apply: 1 }, 'invalid-apply'],
  ];
  for (const [overrides, name] of cases) {
    const outcome = await runReleaseTag(releaseInput(fx, overrides), deps);
    assertRefused(outcome, name);
    assert.equal(outcome.report.preconditions[0]?.status, 'failed');
  }
  assert.deepEqual(calls, []);
});

test('a closed release issue and a blocked one are each refused and write nothing', async () => {
  for (const [gh, name] of [
    [{ issueState: 'CLOSED' }, 'release-issue-closed'],
    [
      { labels: ['release', 'status:blocked-by-human'] },
      'release-issue-blocked',
    ],
  ] as const) {
    const fx = makeFixture();
    const { deps, calls } = harness(fx, { gh });
    const outcome = await runReleaseTag(
      releaseInput(fx, { apply: true }),
      deps,
    );
    assertRefused(outcome, name);
    assertNoWrites(calls);
    assert.deepEqual(
      calls.filter((call) => call.kind === 'gh').map((call) => call.args[0]),
      ['issue'],
    );
    assert.equal(existsSync(join(fx.primary, '.git/FETCH_HEAD')), false);
    assert.deepEqual(localTags(fx), []);
  }
});

test('a gate label from a user-global override also blocks', async () => {
  const fx = makeFixture();
  const configHome = join(fx.root, 'xdg');
  mkdirSync(join(configHome, 'idd-skill'), { recursive: true });
  writeFileSync(
    join(configHome, 'idd-skill', 'config.json'),
    JSON.stringify({
      overrides: [
        {
          match: { repo: 'fixture-owner/fixture-repo' },
          config: { labels: { blockedByHumanLabelName: 'release:hold' } },
        },
      ],
    }),
  );
  const env: NodeJS.ProcessEnv = { ...fx.env, XDG_CONFIG_HOME: configHome };
  delete env.GITHUB_ACTIONS;
  const { deps, calls } = harness(fx, {
    env,
    gh: { labels: ['release', 'release:hold'] },
  });
  const outcome = await runReleaseTag(releaseInput(fx), deps);
  assertRefused(outcome, 'release-issue-blocked');
  assert.match(outcome.report.refusal?.detail ?? '', /release:hold/u);
  assert.deepEqual(
    calls
      .filter((call) => call.kind === 'git')
      .map((call) => subcommand(call.args)),
    ['remote', 'remote', 'worktree'],
  );
});

test('a malformed gate label in the policy is refused', async () => {
  for (const label of ['', 'status:blocked\u0007']) {
    const fx = makeFixture();
    writeFileSync(
      join(fx.primary, '.github/idd/config.json'),
      JSON.stringify({
        iddVersion: VERSION,
        labels: { blockedByHumanLabelName: label },
      }),
    );
    const { deps, calls } = harness(fx);
    assertRefused(
      await runReleaseTag(releaseInput(fx), deps),
      'policy-label-invalid',
    );
    assert.deepEqual(
      calls.filter((call) => call.kind === 'gh'),
      [],
    );
  }
});

test('the gate-label policy read runs under the time bound', async () => {
  const fx = makeFixture();
  const { deps, calls } = harness(fx, {
    wrap: async (request) =>
      request.args[0] === 'worktree'
        ? {
            status: null,
            signal: null,
            stdout: '',
            stderr: '',
            timedOut: true,
            termination: {
              recorded: [4242],
              survivors: [
                { pid: 4242, args: 'git worktree list', signer: false },
              ],
              waitedMs: 5,
              pidRecorded: true,
              listingAvailable: true,
            },
          }
        : null,
  });
  const outcome = await runReleaseTag(releaseInput(fx), deps);
  assertRefused(outcome, 'process-survivor');
  assert.deepEqual(outcome.report.refusal?.processes?.recorded, [4242]);
  assert.deepEqual(
    calls.filter((call) => call.kind === 'gh'),
    [],
  );
  assert.equal(outcome.report.preconditions[2]?.name, 'release-issue');
  assert.equal(outcome.report.preconditions[2]?.status, 'failed');
});

test('a pull request that is not merged, or merged as another commit, is refused', async () => {
  for (const [gh, name] of [
    [{ pullRequestState: 'OPEN' }, 'pull-request-not-merged'],
    [{ mergeOid: 'a'.repeat(40) }, 'merge-commit-mismatch'],
  ] as const) {
    const fx = makeFixture();
    const { deps, calls } = harness(fx, { gh });
    assertRefused(
      await runReleaseTag(releaseInput(fx, { apply: true }), deps),
      name,
    );
    assertNoWrites(calls);
  }
});

test('a default branch that is not the HEAD of origin is refused before any fetch', async () => {
  const fx = makeFixture();
  const { deps, calls } = harness(fx, { gh: { defaultBranch: 'trunk' } });
  assertRefused(
    await runReleaseTag(releaseInput(fx), deps),
    'default-branch-mismatch',
  );
  assertNoWrites(calls);
});

test('a SHA that is not reachable from the default branch on origin is refused', async () => {
  const fx = makeFixture();
  git(fx, fx.seed, ['checkout', '-q', '-b', 'side', fx.base]);
  writeFileSync(join(fx.seed, 'side.txt'), 'side\n');
  git(fx, fx.seed, ['add', '-A']);
  git(fx, fx.seed, ['commit', '-q', '-m', 'chore: side']);
  const side = git(fx, fx.seed, ['rev-parse', 'HEAD']);
  git(fx, fx.seed, ['push', '-q', 'origin', 'HEAD:refs/heads/side']);

  const missing = harness(fx, { gh: { mergeOid: side } });
  assertRefused(
    await runReleaseTag(releaseInput(fx, { mergeSha: side }), missing.deps),
    'merge-commit-missing',
  );

  git(fx, fx.primary, ['fetch', '-q', 'origin', 'side']);
  const present = harness(fx, { gh: { mergeOid: side } });
  const outcome = await runReleaseTag(
    releaseInput(fx, { mergeSha: side, apply: true }),
    present.deps,
  );
  assertRefused(outcome, 'merge-commit-unreachable');
  assert.deepEqual(gitCalls(present.calls, 'tag'), []);
  assert.deepEqual(localTags(fx), []);
});

test('each version file that does not match is refused with its own name', async () => {
  const cases: [ReleaseFiles, string][] = [
    [{ packageVersion: '1.2.2' }, 'package-version-mismatch'],
    [{ iddVersion: '1.2.2' }, 'idd-version-mismatch'],
    [{ templateIddVersion: '1.2.4' }, 'template-idd-version-mismatch'],
    [{ changelog: `## [${VERSION}]\n` }, 'changelog-heading-missing'],
    [
      { changelog: `## [${VERSION}] - 2026-02-30\n` },
      'changelog-heading-missing',
    ],
    [{ changelog: '## [1.2.30] - 2026-10-19\n' }, 'changelog-heading-missing'],
  ];
  for (const [files, name] of cases) {
    const fx = makeFixture(files);
    const { deps, calls } = harness(fx);
    assertRefused(
      await runReleaseTag(releaseInput(fx, { apply: true }), deps),
      name,
    );
    assert.deepEqual(gitCalls(calls, 'tag'), []);
  }
});

test('with no remote tag, apply creates one signed tag, checks it, and pushes it', async () => {
  const fx = makeFixture();
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.decision, 'create');
  assert.equal(outcome.report.created, true);
  assert.equal(outcome.report.found, false);
  assert.equal(outcome.report.pushed, true);
  assert.equal(outcome.report.pushAttempts, 1);
  assert.equal(outcome.report.peeledCommit, fx.sha);
  assert.equal(gitCalls(calls, 'tag').length, 1);
  assert.equal(gitCalls(calls, 'push').length, 1);
  const object = outcome.report.tagObject ?? '';
  assert.deepEqual(remoteTags(fx), [`refs/tags/${TAG} ${object}`]);
  assert.equal(git(fx, fx.origin, ['cat-file', '-t', object]), 'tag');
  assert.equal(git(fx, fx.origin, ['rev-parse', `${object}^{commit}`]), fx.sha);
  git(fx, fx.primary, [
    '-c',
    `gpg.ssh.allowedSignersFile=${fx.allowed}`,
    'verify-tag',
    object,
  ]);
  assert.match(
    git(fx, fx.primary, ['cat-file', 'tag', object]),
    new RegExp(`\\n\\nrelease ${TAG}\\n-----BEGIN SSH SIGNATURE-----`, 'u'),
  );
  assert.deepEqual(
    outcome.report.effects.map((item) => item.status),
    ['done', 'done', 'done', 'done'],
  );
});

test('push.followTags does not push any other tag', async () => {
  const fx = makeFixture();
  git(fx, fx.primary, ['config', 'push.followTags', 'true']);
  git(fx, fx.primary, [
    'tag',
    '-a',
    '-m',
    'unsigned extra',
    'v0.0.1-extra',
    fx.sha,
  ]);
  const { deps } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.deepEqual(remoteTags(fx), [
    `refs/tags/${TAG} ${outcome.report.tagObject}`,
  ]);
});

test('a remote tag at the SHA with a valid signature is found, and nothing is written', async () => {
  const fx = makeFixture();
  const object = pushSignedTag(fx, fx.seed, fx.sha);
  const before = remoteTags(fx);
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.decision, 'found');
  assert.equal(outcome.report.found, true);
  assert.equal(outcome.report.created, false);
  assert.equal(outcome.report.tagObject, object);
  assert.equal(outcome.report.peeledCommit, fx.sha);
  assert.equal(outcome.report.pushed, false);
  assert.deepEqual(gitCalls(calls, 'tag'), []);
  assert.deepEqual(gitCalls(calls, 'push'), []);
  assert.deepEqual(localTags(fx), []);
  assert.deepEqual(remoteTags(fx), before);
  assert.deepEqual(
    outcome.report.effects.map((item) => item.status),
    ['skipped', 'skipped', 'skipped', 'skipped'],
  );
});

test('a found remote tag is not refused over a stale local tag', async () => {
  const fx = makeFixture();
  const object = pushSignedTag(fx, fx.seed, fx.sha);
  git(fx, fx.primary, ['tag', TAG, fx.base]);
  const before = localTags(fx);
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.decision, 'found');
  assert.equal(outcome.report.tagObject, object);
  assert.equal(outcome.report.preconditions.at(-1)?.status, 'not-run');
  assert.deepEqual(localTags(fx), before);
  assert.deepEqual(gitCalls(calls, 'push'), []);
});

test('a dry run with a configured tag refspec still creates no tag ref', async () => {
  const fx = makeFixture();
  pushSignedTag(fx, fx.seed, fx.sha);
  git(fx, fx.primary, [
    'config',
    '--add',
    'remote.origin.fetch',
    '+refs/tags/*:refs/tags/*',
  ]);
  git(fx, fx.primary, [
    'config',
    '--add',
    'remote.origin.fetch',
    '+refs/*:refs/*',
  ]);
  const { deps } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.decision, 'found');
  assert.deepEqual(localTags(fx), []);
});

test('a remote tag at another commit and an unsigned one at the SHA are refused and left unchanged', async () => {
  const other = makeFixture();
  pushSignedTag(other, other.seed, other.base);
  const otherBefore = remoteTags(other);
  const first = harness(other);
  assertRefused(
    await runReleaseTag(releaseInput(other, { apply: true }), first.deps),
    'remote-tag-invalid',
  );
  assert.deepEqual(remoteTags(other), otherBefore);
  assert.deepEqual(gitCalls(first.calls, 'push'), []);

  const unsigned = makeFixture();
  git(unsigned, unsigned.seed, [
    'tag',
    '-a',
    '-m',
    `release ${TAG}`,
    TAG,
    unsigned.sha,
  ]);
  git(unsigned, unsigned.seed, ['push', '-q', 'origin', `refs/tags/${TAG}`]);
  const unsignedBefore = remoteTags(unsigned);
  const second = harness(unsigned);
  assertRefused(
    await runReleaseTag(releaseInput(unsigned, { apply: true }), second.deps),
    'remote-tag-unsigned',
  );
  assert.deepEqual(remoteTags(unsigned), unsignedBefore);
  assert.deepEqual(gitCalls(second.calls, 'push'), []);
  assert.deepEqual(localTags(unsigned), []);
});

test('a local tag at another commit is refused, kept, and named', async () => {
  const fx = makeFixture();
  git(fx, fx.primary, ['tag', '-s', '-m', `release ${TAG}`, TAG, fx.base]);
  const before = localTags(fx);
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'local-tag-conflict');
  assert.match(
    outcome.report.refusal?.detail ?? '',
    new RegExp(`local tag ${TAG.replaceAll('.', '\\.')} \\(`, 'u'),
  );
  assert.deepEqual(localTags(fx), before);
  assert.deepEqual(gitCalls(calls, 'push'), []);
});

test('a lightweight local tag at the SHA is refused and kept', async () => {
  const fx = makeFixture();
  git(fx, fx.primary, ['tag', TAG, fx.sha]);
  const before = localTags(fx);
  const { deps } = harness(fx);
  assertRefused(
    await runReleaseTag(releaseInput(fx, { apply: true }), deps),
    'local-tag-conflict',
  );
  assert.deepEqual(localTags(fx), before);
  assert.deepEqual(remoteTags(fx), []);
});

test('a signed local tag at the SHA skips creation, then is checked and pushed', async () => {
  const fx = makeFixture();
  git(fx, fx.primary, ['tag', '-s', '-m', `release ${TAG}`, TAG, fx.sha]);
  const local = git(fx, fx.primary, ['rev-parse', `refs/tags/${TAG}`]);
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.decision, 'use-local-tag');
  assert.equal(outcome.report.created, false);
  assert.equal(outcome.report.tagObject, local);
  assert.deepEqual(gitCalls(calls, 'tag'), []);
  assert.equal(gitCalls(calls, 'verify-tag').length >= 2, true);
  assert.deepEqual(remoteTags(fx), [`refs/tags/${TAG} ${local}`]);
  assert.deepEqual(
    outcome.report.effects.map((item) => item.status),
    ['skipped', 'done', 'done', 'done'],
  );
});

test('a failed signature check keeps the local tag and makes no push', async () => {
  const fx = makeFixture();
  const otherKey = join(fx.root, 'other-key');
  execFileSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', EMAIL, '-f', otherKey],
    {
      env: fx.env,
      stdio: 'ignore',
    },
  );
  git(fx, fx.primary, [
    '-c',
    `user.signingkey=${otherKey}`,
    'tag',
    '-s',
    '-m',
    `release ${TAG}`,
    TAG,
    fx.sha,
  ]);
  const before = localTags(fx);
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'signature-check-failed');
  assert.deepEqual(localTags(fx), before);
  assert.deepEqual(gitCalls(calls, 'push'), []);
  assert.deepEqual(remoteTags(fx), []);
});

test('an OpenPGP MESSAGE armor is verified as a signature, not refused as unsigned', async () => {
  const fx = makeFixture();
  const message = join(fx.root, 'message.txt');
  writeFileSync(
    message,
    `release ${TAG}\n-----BEGIN PGP MESSAGE-----\n\nnot a real signature\n-----END PGP MESSAGE-----\n`,
  );
  git(fx, fx.primary, ['tag', '-a', '-F', message, TAG, fx.sha]);
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'signature-check-failed');
  assert.equal(gitCalls(calls, 'verify-tag').length, 1);
  assert.deepEqual(gitCalls(calls, 'push'), []);
  assert.equal(localTags(fx).length, 1);
});

test('a push rejected once with an empty remote is retried once and lands', async () => {
  const fx = makeFixture();
  const flag = join(fx.root, 'rejected-once');
  writeStub(
    fx,
    'origin.git/hooks/pre-receive',
    `if [ ! -f "${flag}" ]; then : > "${flag}"; echo "rejected once" >&2; exit 1; fi\nexit 0\n`,
  );
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.pushAttempts, 2);
  assert.equal(gitCalls(calls, 'push').length, 2);
  assert.equal(outcome.report.pushed, true);
  assert.deepEqual(remoteTags(fx), [
    `refs/tags/${TAG} ${outcome.report.tagObject}`,
  ]);
});

test('a push rejected twice is refused after two invocations', async () => {
  const fx = makeFixture();
  writeStub(
    fx,
    'origin.git/hooks/pre-receive',
    'echo "always rejected" >&2\nexit 1\n',
  );
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'push-failed');
  assert.equal(gitCalls(calls, 'push').length, 2);
  assert.equal(outcome.report.pushed, false);
  assert.deepEqual(remoteTags(fx), []);
  assert.equal(localTags(fx).length, 1);
});

test('a push that landed but reported failure is not retried', async () => {
  const fx = makeFixture();
  let failed = false;
  const { deps, calls } = harness(fx, {
    wrap: async (request, real) => {
      if (request.args[0] !== 'push' || failed) return null;
      failed = true;
      const result = await real(request);
      assert.equal(result.status, 0);
      return {
        ...result,
        status: 1,
        stderr: 'fatal: the remote end hung up unexpectedly',
      };
    },
  });
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.pushAttempts, 1);
  assert.equal(gitCalls(calls, 'push').length, 1);
  assert.equal(outcome.report.pushed, true);
});

test('another tag object at the SHA after a failed push is a conflict, not a landed push', async () => {
  const fx = makeFixture();
  let raced = '';
  const { deps } = harness(fx, {
    wrap: async (request) => {
      if (request.args[0] !== 'push' || raced !== '') return null;
      raced = pushSignedTag(fx, fx.seed, fx.sha, 'a competing tag');
      return {
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'error: failed to push some refs',
      };
    },
  });
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'remote-tag-conflict');
  assert.equal(outcome.report.pushed, false);
  assert.notEqual(outcome.report.tagObject, raced);
  assert.deepEqual(remoteTags(fx), [`refs/tags/${TAG} ${raced}`]);
});

test('a timed-out post-push read keeps its process record', async () => {
  const fx = makeFixture();
  let pushed = false;
  const { deps } = harness(fx, {
    wrap: async (request) => {
      if (request.args[0] === 'push') {
        pushed = true;
        return null;
      }
      if (pushed && request.args[0] === 'ls-remote') {
        return {
          status: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: true,
          termination: {
            recorded: [4343],
            survivors: [],
            waitedMs: 7,
            pidRecorded: true,
            listingAvailable: true,
          },
        };
      }
      return null;
    },
  });
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'post-push-check-failed');
  assert.equal(outcome.report.pushed, true);
  assert.deepEqual(outcome.report.refusal?.processes, {
    recorded: [4343],
    survivors: [],
    waitedMs: 7,
  });
});

test('a push URL that names another repository is refused before any tag is made', async () => {
  const fx = makeFixture();
  const elsewhere = join(fx.root, 'elsewhere.git');
  git(fx, fx.root, ['init', '-q', '--bare', '-b', 'main', elsewhere]);
  git(fx, fx.primary, ['config', 'remote.origin.pushurl', elsewhere]);
  const { deps, calls } = harness(fx);
  assertRefused(
    await runReleaseTag(releaseInput(fx, { apply: true }), deps),
    'push-url-mismatch',
  );
  assertNoWrites(calls);
  assert.deepEqual(
    calls.filter((call) => call.kind === 'gh'),
    [],
  );
});

test('a malformed origin URL is refused by name, not thrown', async () => {
  const fx = makeFixture();
  git(fx, fx.primary, ['config', 'remote.origin.url', 'file:///%ZZ']);
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx), deps);
  assertRefused(outcome, 'origin-url-unreadable');
  assert.deepEqual(
    calls.filter((call) => call.kind === 'gh'),
    [],
  );
});

test('fetch and push URLs on one transport must use one port', async () => {
  for (const [fetchUrl, pushUrl, name] of [
    [
      'ssh://git@github.com/fixture-owner/fixture-repo.git',
      'ssh://git@github.com:2222/fixture-owner/fixture-repo.git',
      'push-url-mismatch',
    ],
    [
      'https://github.com/fixture-owner/fixture-repo.git',
      'git@github.com:fixture-owner/fixture-repo.git',
      // The repository check passes; the closed fake issue then stops the
      // run before any command could reach the network.
      'release-issue-closed',
    ],
  ] as const) {
    const fx = makeFixture();
    git(fx, fx.primary, ['config', 'remote.origin.url', fetchUrl]);
    git(fx, fx.primary, ['config', 'remote.origin.pushurl', pushUrl]);
    const { deps, calls } = harness(fx, { gh: { issueState: 'CLOSED' } });
    const outcome = await runReleaseTag(releaseInput(fx), deps);
    assertRefused(outcome, name);
    assertNoWrites(calls);
    assert.equal(
      calls.some(
        (call) => call.kind === 'git' && subcommand(call.args) === 'ls-remote',
      ),
      false,
    );
  }
});

test('a GH_REPO that names another repository is refused', async () => {
  const fx = makeFixture();
  const { deps, calls } = harness(fx, {
    env: { ...fx.env, GH_REPO: 'someone/else' },
  });
  assertRefused(
    await runReleaseTag(releaseInput(fx), deps),
    'gh-repo-mismatch',
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === 'gh'),
    [],
  );
});

test('a git older than 2.44 is refused before an SSH tag is signed', async () => {
  const fx = makeFixture();
  for (const apply of [false, true]) {
    const { deps, calls } = harness(fx, {
      wrap: async (request) =>
        request.args[0] === '--version'
          ? {
              status: 0,
              signal: null,
              stdout: 'git version 2.43.0\n',
              stderr: '',
            }
          : null,
    });
    const outcome = await runReleaseTag(releaseInput(fx, { apply }), deps);
    assertRefused(outcome, 'git-version-unsupported');
    assert.equal(outcome.report.effects[0]?.status, 'failed');
    assert.deepEqual(gitCalls(calls, 'tag'), []);
  }
  assert.deepEqual(localTags(fx), []);
  assert.deepEqual(remoteTags(fx), []);

  // OpenPGP signing on that git already fails closed, so it is not gated.
  git(fx, fx.primary, ['config', 'gpg.format', 'openpgp']);
  const { deps } = harness(fx, {
    wrap: async (request) =>
      request.args[0] === '--version' ? ok('git version 2.43.0\n') : null,
  });
  const outcome = await runReleaseTag(releaseInput(fx), deps);
  assert.equal(outcome.exitStatus, 0, JSON.stringify(outcome.report, null, 2));
  assert.equal(outcome.report.decision, 'create');
});

test('a signing setting that cannot be read is refused, not read as unset', async () => {
  const unreadable: CommandResult = {
    status: 3,
    signal: null,
    stdout: '',
    stderr: 'fatal: bad config line 1',
  };
  const stalled: CommandResult = {
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: true,
    termination: {
      recorded: [],
      survivors: [],
      waitedMs: 0,
      pidRecorded: true,
      listingAvailable: true,
    },
  };
  for (const [result, name] of [
    [unreadable, 'signing-config-unreadable'],
    [stalled, 'command-timeout'],
  ] as const) {
    const fx = makeFixture();
    const { deps, calls } = harness(fx, {
      wrap: async (request) =>
        request.args[0] === 'config' && request.args[2] === 'gpg.format'
          ? result
          : null,
    });
    const outcome = await runReleaseTag(
      releaseInput(fx, { apply: true }),
      deps,
    );
    assertRefused(outcome, name);
    assert.deepEqual(gitCalls(calls, 'tag'), []);
    assert.deepEqual(localTags(fx), []);
  }
});

test('a timed-out local-tag read after a failed signing keeps its own refusal', async () => {
  const fx = makeFixture();
  const signer = writeStub(fx, 'failing-signer', 'exit 1\n');
  git(fx, fx.primary, ['config', 'gpg.ssh.program', signer]);
  let signed = false;
  const { deps } = harness(fx, {
    wrap: async (request) => {
      if (subcommand(request.args) === 'tag') {
        signed = true;
        return {
          status: 1,
          signal: null,
          stdout: '',
          stderr: 'error: unable to sign the tag',
        };
      }
      if (signed && subcommand(request.args) === 'rev-parse') {
        return {
          status: null,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: true,
          termination: {
            recorded: [4444],
            survivors: [{ pid: 4444, args: 'git rev-parse', signer: false }],
            waitedMs: 9,
            pidRecorded: true,
            listingAvailable: true,
          },
        };
      }
      return null;
    },
  });
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'process-survivor');
  assert.match(
    outcome.report.refusal?.detail ?? '',
    /signing v1\.2\.3 failed/u,
  );
  assert.deepEqual(outcome.report.refusal?.processes?.recorded, [4444]);
});

test('a broken signer leaves no tag and no unsigned tag', {
  skip:
    !HOST_GIT_FAILS_A_FAILED_SSH_SIGN &&
    'the host git is older than 2.44.0 and writes an unsigned tag when an SSH signer fails',
}, async () => {
  const fx = makeFixture();
  const signer = writeStub(
    fx,
    'broken-signer',
    'echo "signer broke" >&2\nexit 1\n',
  );
  git(fx, fx.primary, ['config', 'gpg.ssh.program', signer]);
  const { deps, calls } = harness(fx);
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'signing-failed');
  assert.match(
    outcome.report.refusal?.detail ?? '',
    /no local v1\.2\.3 was created/u,
  );
  assert.deepEqual(localTags(fx), []);
  const objects = git(fx, fx.primary, [
    'cat-file',
    '--batch-all-objects',
    '--batch-check',
  ]);
  assert.equal(
    objects.split('\n').some((line) => line.split(' ')[1] === 'tag'),
    false,
  );
  assert.deepEqual(gitCalls(calls, 'push'), []);
  assert.deepEqual(remoteTags(fx), []);
});

test('the time bound terminates the signing tree, including the stub child', {
  skip: SKIP_PROCESS_TREE && 'the process-tree fixtures need POSIX ps and sh',
}, async () => {
  const fx = makeFixture();
  const signerPid = join(fx.root, 'signer.pid');
  const childPid = join(fx.root, 'child.pid');
  markerFiles.push(
    { file: signerPid, root: fx.root },
    { file: childPid, root: fx.root },
  );
  const child = writeStub(fx, 'slow-child', 'sleep 30\n');
  const signer = writeStub(
    fx,
    'slow-signer',
    `echo $$ > "${signerPid}"\n"${child}" &\necho $! > "${childPid}"\nsleep 30\n`,
  );
  git(fx, fx.primary, ['config', 'gpg.ssh.program', signer]);
  const { deps } = harness(fx, { timeBoundMs: 2_000, sharedWaitMs: 3_000 });
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'signing-timeout');
  const [signerProcess] = readPids(signerPid);
  const [childProcess] = readPids(childPid);
  assert.ok(
    signerProcess !== undefined && childProcess !== undefined,
    'the stub recorded its PIDs',
  );
  const processes = outcome.report.refusal?.processes;
  assert.ok(processes !== null && processes !== undefined);
  assert.ok(processes.recorded.includes(signerProcess));
  assert.ok(processes.recorded.includes(childProcess));
  assert.deepEqual(processes.survivors, []);
  assert.ok(processes.waitedMs < 3_000);
  assert.equal(isAlive(signerProcess), false);
  assert.equal(isAlive(childProcess), false);
  assert.deepEqual(localTags(fx), []);
  assert.deepEqual(remoteTags(fx), []);
});

test('a survivor that is not the signer is refused, under one shared wait', {
  skip: SKIP_PROCESS_TREE && 'the process-tree fixtures need POSIX ps and sh',
}, async () => {
  const fx = makeFixture();
  const survivors = join(fx.root, 'survivors.pid');
  markerFiles.push({ file: survivors, root: fx.root });
  const sleeper = writeStub(
    fx,
    'stubborn-child',
    `echo $$ >> "${survivors}"\ntrap '' TERM\nwhile :; do sleep 1; done\n`,
  );
  const signer = writeStub(
    fx,
    'stubborn-signer',
    `for i in 1 2 3; do "${sleeper}" & done\nsleep 30\n`,
  );
  git(fx, fx.primary, ['config', 'gpg.ssh.program', signer]);
  const wait = 1_500;
  const { deps, calls } = harness(fx, {
    timeBoundMs: 2_000,
    sharedWaitMs: wait,
  });
  try {
    const outcome = await runReleaseTag(
      releaseInput(fx, { apply: true }),
      deps,
    );
    assertRefused(outcome, 'process-survivor');
    // No git command runs after the timed-out `git tag` while the tree
    // is unconfirmed.
    assert.equal(calls.at(-1)?.kind, 'git');
    assert.equal(subcommand(calls.at(-1)?.args ?? []), 'tag');
    assert.match(
      outcome.report.refusal?.detail ?? '',
      /local tag was not read/u,
    );
    const pids = readPids(survivors);
    assert.equal(pids.length, 3);
    const processes = outcome.report.refusal?.processes;
    assert.ok(processes !== null && processes !== undefined);
    assert.deepEqual(
      processes.survivors.map((item) => [item.pid, item.signer]).sort(),
      pids.map((pid) => [pid, false]).sort(),
    );
    assert.ok(processes.waitedMs >= wait, `waited ${processes.waitedMs} ms`);
    assert.ok(processes.waitedMs < 2 * wait, `waited ${processes.waitedMs} ms`);
    assert.deepEqual(remoteTags(fx), []);
  } finally {
    killMarkerPids();
  }
});

test('a signer that outlives the wait is reported as a leak of a signing timeout', {
  skip: SKIP_PROCESS_TREE && 'the process-tree fixtures need POSIX ps and sh',
}, async () => {
  const fx = makeFixture();
  const signerPid = join(fx.root, 'signer.pid');
  markerFiles.push({ file: signerPid, root: fx.root });
  const signer = writeStub(
    fx,
    'leaky-signer',
    `echo $$ > "${signerPid}"\ntrap '' TERM\nwhile :; do sleep 1; done\n`,
  );
  git(fx, fx.primary, ['config', 'gpg.ssh.program', signer]);
  const { deps } = harness(fx, { timeBoundMs: 2_000, sharedWaitMs: 2_500 });
  try {
    const outcome = await runReleaseTag(
      releaseInput(fx, { apply: true }),
      deps,
    );
    assertRefused(outcome, 'signing-timeout');
    const [pid] = readPids(signerPid);
    assert.deepEqual(
      outcome.report.refusal?.processes?.survivors.map((item) => [
        item.pid,
        item.signer,
      ]),
      [[pid, true]],
    );
    assert.match(outcome.report.refusal?.detail ?? '', /signing program/u);
  } finally {
    killMarkerPids();
  }
});

test('a timeout after signing wrote the tag names the local tag', {
  skip: SKIP_PROCESS_TREE && 'the process-tree fixtures need POSIX ps and sh',
}, async () => {
  const fx = makeFixture();
  writeStub(
    fx,
    'primary/.git/hooks/reference-transaction',
    '[ "$1" = committed ] || exit 0\nwhile read -r old new ref; do\n  case "$ref" in refs/tags/*) exec sleep 30;; esac\ndone\nexit 0\n',
  );
  const { deps, calls } = harness(fx, {
    timeBoundMs: 3_000,
    sharedWaitMs: 3_000,
  });
  const outcome = await runReleaseTag(releaseInput(fx, { apply: true }), deps);
  assertRefused(outcome, 'signing-timeout');
  const tags = localTags(fx);
  assert.equal(tags.length, 1);
  const object = tags[0]?.split(' ')[1] ?? '';
  assert.match(
    outcome.report.refusal?.detail ?? '',
    new RegExp(
      `local tag v1\\.2\\.3 \\(${object}\\) exists and was left in place`,
      'u',
    ),
  );
  assert.deepEqual(gitCalls(calls, 'push'), []);
  assert.deepEqual(remoteTags(fx), []);
});

test('the production default-branch read refuses a checkout that is not the process directory', async () => {
  const fx = makeFixture();
  const deps = createReleaseTagDeps({ env: fx.env });
  const result = await deps.run({
    kind: 'gh',
    args: [
      'repo',
      'view',
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    ],
    cwd: fx.primary,
  });
  assert.equal(result.status, null);
  assert.match(result.error ?? '', /not the repository checkout/u);
  const other = await deps.run({
    kind: 'gh',
    args: ['api', 'user'],
    cwd: process.cwd(),
  });
  assert.equal(other.status, null);
  assert.match(other.error ?? '', /refuses this gh argument list/u);
});

test('parseRepositoryIdentity reads hosted and local remote URLs', () => {
  const https = {
    kind: 'hosted',
    transport: 'https',
    host: 'github.com',
    port: 443,
    owner: 'kurone-kito',
    repo: 'idd-skill',
  };
  const ssh = { ...https, transport: 'ssh', port: 22 };
  const cases: [string, unknown][] = [
    ['https://github.com/kurone-kito/idd-skill.git', https],
    ['https://github.com/kurone-kito/idd-skill/', https],
    ['git@github.com:kurone-kito/idd-skill.git', ssh],
    ['ssh://git@github.com/kurone-kito/idd-skill', ssh],
    ['ssh://git@github.com:2222/kurone-kito/idd-skill', { ...ssh, port: 2222 }],
    ['git+ssh://git@github.com/kurone-kito/idd-skill', ssh],
    [
      'git://github.com/kurone-kito/idd-skill',
      { ...https, transport: 'git', port: 9418 },
    ],
    [
      'https://GitHub.com/Kurone-Kito/idd-skill',
      { ...https, owner: 'Kurone-Kito' },
    ],
    ['/srv/git/repo.git', { kind: 'local', path: '/srv/git/repo.git' }],
    ['file:///srv/git/repo.git', { kind: 'local', path: '/srv/git/repo.git' }],
  ];
  for (const [url, expected] of cases) {
    assert.deepEqual(parseRepositoryIdentity(url), expected, url);
  }
  for (const url of [
    '',
    'relative/path',
    'https://github.com/only-owner',
    'https://github.com/a/b/c',
    'ftp://github.com/a/b',
    'https://github.com/a/b\n',
    ' https://github.com/a/b',
    'https://github.com/a/b ',
    'https://github.com:0/a/b',
    'https://github.com:70000/a/b',
    'file:///srv/repo%zz',
    'file:///%ZZ',
  ]) {
    assert.equal(parseRepositoryIdentity(url), null, url);
  }
});

test('the production deps refuse a bound that is not a positive number', () => {
  assert.throws(() => createReleaseTagDeps({ timeBoundMs: 0 }), TypeError);
  assert.throws(
    () => createReleaseTagDeps({ sharedWaitMs: Number.NaN }),
    TypeError,
  );
  const deps = createReleaseTagDeps();
  assert.equal(
    deps.ghRepositorySlug({ kind: 'local', path: '/srv/repo.git' }),
    null,
  );
  assert.equal(
    deps.ghRepositorySlug({
      kind: 'hosted',
      transport: 'https',
      host: 'github.com',
      port: 443,
      owner: 'o',
      repo: 'r',
    }),
    'github.com/o/r',
  );
  assert.equal(
    deps.ghRepositorySlug({
      kind: 'hosted',
      transport: 'https',
      host: 'github.com',
      port: 443,
      owner: 'cat_acme',
      repo: 'r',
    }),
    'github.com/cat_acme/r',
  );
});
