import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { trackTempDirectories } from './temp-fixtures.mts';
import { fixtureEnv, stubExecutable } from './test-utils.mts';

const mkdtemp = trackTempDirectories();
const VERSION = '1.2.3';
const PULL_REQUEST = 4521;
const ISSUE = 4522;
const TAG = `v${VERSION}`;
const EMAIL = 'release@example.invalid';
const BIN = fileURLToPath(
  new URL('../bin/idd-release-tag.mjs', import.meta.url),
);

interface Fixture {
  root: string;
  origin: string;
  primary: string;
  allowedSigners: string;
  sha: string;
  env: NodeJS.ProcessEnv;
}

function git(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeFixture(): Fixture {
  const root = mkdtemp(join(tmpdir(), 'release-tag-cli-'));
  const env: NodeJS.ProcessEnv = {
    ...fixtureEnv(),
    GIT_AUTHOR_NAME: 'release fixture',
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_COMMITTER_NAME: 'release fixture',
    GIT_COMMITTER_EMAIL: EMAIL,
  };
  delete env.SSH_AUTH_SOCK;
  delete env.GH_REPO;

  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const primary = join(root, 'primary');
  git(env, root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(env, root, ['clone', '-q', origin, seed]);
  git(env, seed, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(seed, 'README.md'), 'fixture\n');
  git(env, seed, ['add', '-A']);
  git(env, seed, ['commit', '-q', '-m', 'chore: start']);

  mkdirSync(join(seed, '.github/idd'), { recursive: true });
  mkdirSync(join(seed, 'idd-template/.github/idd'), { recursive: true });
  writeFileSync(
    join(seed, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: VERSION }, null, 2)}\n`,
  );
  writeFileSync(
    join(seed, '.github/idd/config.json'),
    `${JSON.stringify(
      {
        iddVersion: VERSION,
        labels: { blockedByHumanLabelName: 'status:blocked-by-human' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(seed, 'idd-template/.github/idd/config.json'),
    `${JSON.stringify({ iddVersion: VERSION }, null, 2)}\n`,
  );
  writeFileSync(
    join(seed, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n## [${VERSION}] - 2026-10-19\n\n- Release.\n`,
  );
  git(env, seed, ['add', '-A']);
  git(env, seed, ['commit', '-q', '-m', `chore(release): bump to ${VERSION}`]);
  const sha = git(env, seed, ['rev-parse', 'HEAD']);
  git(env, seed, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  git(env, root, ['clone', '-q', origin, primary]);

  const allowedSigners = join(root, 'allowed_signers');
  writeFileSync(allowedSigners, `${EMAIL} ssh-ed25519 AAAAfixture\n`);
  return { root, origin, primary, allowedSigners, sha, env };
}

function validArgs(fx: Fixture): string[] {
  return [
    '--operation',
    'signed-annotated-tag',
    '--version',
    VERSION,
    '--merge-sha',
    fx.sha,
    '--pr',
    String(PULL_REQUEST),
    '--issue',
    String(ISSUE),
    '--allowed-signers',
    fx.allowedSigners,
  ];
}

function configureSigning(fx: Fixture): void {
  const key = join(fx.root, 'ssh-signing-key');
  execFileSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', EMAIL, '-f', key],
    { env: fx.env, stdio: 'ignore' },
  );
  const publicKey = readFileSync(`${key}.pub`, 'utf8')
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');
  writeFileSync(fx.allowedSigners, `${EMAIL} ${publicKey}\n`);
  git(fx.env, fx.primary, ['config', 'gpg.format', 'ssh']);
  git(fx.env, fx.primary, ['config', 'user.signingkey', key]);
  git(fx.env, fx.primary, ['config', 'user.name', 'release fixture']);
  git(fx.env, fx.primary, ['config', 'user.email', EMAIL]);
}

function gitStub(): string {
  return `
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const log = process.env.IDD_RELEASE_TAG_STUB_LOG;
if (log) appendFileSync(log, 'git ' + JSON.stringify(args) + '\\n');
if (args[0] === '--version' && process.env.IDD_RELEASE_TAG_TEST_GIT_VERSION) {
  process.stdout.write('git version ' + process.env.IDD_RELEASE_TAG_TEST_GIT_VERSION + '\\n');
  process.exitCode = 0;
} else if (args[0] === 'remote' && args[1] === 'get-url' && args.includes('origin')) {
  process.stdout.write('https://github.com/fixture-owner/fixture-repo.git\\n');
  process.exitCode = 0;
} else if (process.env.IDD_RELEASE_TAG_FORWARD_GIT === '1') {
  const child = spawnSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: process.env.IDD_RELEASE_TAG_REAL_PATH },
  });
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  if (child.error) process.stderr.write(String(child.error));
  process.exitCode = child.status ?? 97;
} else {
  process.stderr.write('unexpected git invocation\\n');
  process.exitCode = 97;
}
`;
}

function ghStub(
  mergeSha: string,
  defaultBranchFailure?: { status: number; stderr: string },
): string {
  const failureStatus = defaultBranchFailure?.status ?? 0;
  const failureStderr = JSON.stringify(defaultBranchFailure?.stderr ?? '');
  return `
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.IDD_RELEASE_TAG_STUB_LOG;
if (log) appendFileSync(log, 'gh ' + JSON.stringify(args) + '\\n');
if (args[0] === 'issue' && args[1] === 'view' && args[2] === '${ISSUE}') {
  process.stdout.write(JSON.stringify({ state: 'OPEN', labels: [{ name: 'release' }] }));
} else if (args[0] === 'pr' && args[1] === 'view' && args[2] === '${PULL_REQUEST}') {
  process.stdout.write(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: '${mergeSha}' } }));
} else if (args[0] === 'repo' && args[1] === 'view') {
  if (${failureStatus} !== 0) {
    process.stderr.write(${failureStderr} + '\\n');
    process.exitCode = ${failureStatus};
  } else {
    process.stdout.write('main\\n');
  }
} else {
  process.stderr.write('unexpected gh invocation: ' + JSON.stringify(args) + '\\n');
  process.exitCode = 97;
}
`;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  log: string;
}

let runNumber = 0;

function runCli(
  fx: Fixture,
  args: readonly string[],
  forwardGit = false,
  options: {
    ghSource?: string;
    helperErrorEnvelope?: boolean;
    gitVersion?: string;
  } = {},
): CliResult {
  const log = join(fx.root, `cli-${runNumber++}.log`);
  writeFileSync(log, '');
  const restoreGit = stubExecutable('git', gitStub());
  const restoreGh = stubExecutable('gh', options.ghSource ?? ghStub(fx.sha));
  try {
    const env = fixtureEnv();
    env.IDD_RELEASE_TAG_STUB_LOG = log;
    env.IDD_RELEASE_TAG_REAL_PATH = fx.env.PATH ?? '';
    env.IDD_RELEASE_TAG_FORWARD_GIT = forwardGit ? '1' : '0';
    if (options.gitVersion === undefined) {
      delete env.IDD_RELEASE_TAG_TEST_GIT_VERSION;
    } else {
      env.IDD_RELEASE_TAG_TEST_GIT_VERSION = options.gitVersion;
    }
    env.GITHUB_ACTIONS = 'true';
    if (options.helperErrorEnvelope) {
      env.IDD_HELPER_ERROR_ENVELOPE = '1';
    } else {
      delete env.IDD_HELPER_ERROR_ENVELOPE;
    }
    delete env.GH_REPO;
    const result = spawnSync(process.execPath, [BIN, ...args], {
      cwd: fx.primary,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      log: readFileSync(log, 'utf8'),
    };
  } finally {
    restoreGh();
    restoreGit();
  }
}

test('help describes the signed tag operation, inputs, and dry-run default', () => {
  const fx = makeFixture();
  const result = runCli(fx, ['--help']);
  assert.equal(
    result.status,
    0,
    `${result.stderr}\n${result.stdout}\n${result.log}`,
  );
  assert.match(result.stdout, /signed-annotated-tag/u);
  assert.match(result.stdout, /--version/u);
  assert.match(result.stdout, /--merge-sha/u);
  assert.match(result.stdout, /--pr\s/u);
  assert.match(result.stdout, /--issue/u);
  assert.match(result.stdout, /--allowed-signers/u);
  assert.match(result.stdout, /Open release issue number\./u);
  assert.doesNotMatch(result.stdout, /release label/u);
  assert.match(result.stdout, /Dry-run is the default/u);
  assert.equal(result.log, '');
});

test('helper error envelope preserves transport classification for failed gh reads', () => {
  const fx = makeFixture();
  const ghSource = [
    "process.stderr.write('gh: HTTP 503\\n');",
    'process.exitCode = 1;',
  ].join('\n');
  const result = runCli(fx, validArgs(fx), true, {
    ghSource,
    helperErrorEnvelope: true,
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    JSON.parse(result.stdout).refusal.name,
    'release-issue-unreadable',
  );
  const envelopeLine = result.stderr
    .split('\n')
    .find((line) => line.startsWith('{'));
  assert.ok(envelopeLine, result.stderr);
  const envelope = JSON.parse(envelopeLine).iddHelperError;
  assert.equal(envelope.kind, 'transport');
  assert.equal(envelope.httpStatus, 503);
  assert.equal(envelope.notDispatched, undefined);
});

test('helper error envelope classifies failed default-branch gh reads', () => {
  for (const scenario of [
    { status: 404, kind: 'not-found' },
    { status: 503, kind: 'transport' },
  ] as const) {
    const fx = makeFixture();
    const result = runCli(fx, validArgs(fx), true, {
      ghSource: ghStub(fx.sha, {
        status: scenario.status,
        stderr: `gh: HTTP ${scenario.status}`,
      }),
      helperErrorEnvelope: true,
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      JSON.parse(result.stdout).refusal.name,
      'default-branch-unreadable',
    );
    const envelopeLine = result.stderr
      .split('\n')
      .find((line) => line.startsWith('{'));
    assert.ok(envelopeLine, result.stderr);
    const envelope = JSON.parse(envelopeLine).iddHelperError;
    assert.equal(envelope.kind, scenario.kind);
    assert.equal(envelope.httpStatus, scenario.status);
  }
});

test('unknown, missing, malformed, and unknown-flag inputs stop before git and gh', () => {
  const fx = makeFixture();
  const valid = validArgs(fx);
  const replace = (args: string[], flag: string, value: string): string[] => {
    const copy = [...args];
    copy[copy.indexOf(flag) + 1] = value;
    return copy;
  };
  const cases: { name: string; args: string[] }[] = [
    { name: 'unknown operation', args: replace(valid, '--operation', 'other') },
    { name: 'missing inputs', args: ['--operation', 'signed-annotated-tag'] },
    { name: 'malformed version', args: replace(valid, '--version', '1.2') },
    { name: 'malformed merge SHA', args: replace(valid, '--merge-sha', 'abc') },
    {
      name: 'malformed pull request',
      args: replace(valid, '--pr', '01'),
    },
    { name: 'unknown flag', args: [...valid, '--unexpected'] },
  ];

  for (const scenario of cases) {
    const result = runCli(fx, scenario.args);
    assert.equal(result.status, 1, `${scenario.name}: ${result.stderr}`);
    assert.equal(result.log, '', `${scenario.name} invoked git or gh`);
    if (scenario.name === 'unknown operation') {
      assert.equal(JSON.parse(result.stdout).refusal.name, 'unknown-operation');
    }
    if (scenario.name === 'malformed version') {
      assert.equal(JSON.parse(result.stdout).refusal.name, 'invalid-version');
    }
  }
});

test('default dry-run validates against a local bare remote without creating or pushing a tag', () => {
  const fx = makeFixture();
  const result = runCli(fx, validArgs(fx), true);
  assert.equal(
    result.status,
    0,
    `${result.stderr}\n${result.stdout}\n${result.log}`,
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.decision, 'create');
  assert.equal(report.created, false);
  assert.equal(report.pushAttempts, 0);
  assert.equal(report.pushed, false);
  assert.match(result.log, /gh \["issue","view","4522"/u);
  assert.match(result.log, /gh \["pr","view","4521"/u);
  assert.doesNotMatch(result.log, /git \["push"/u);

  const localTag = spawnSync(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/tags/${TAG}`],
    { cwd: fx.primary, env: fx.env, encoding: 'utf8' },
  );
  assert.equal(localTag.status, 1, localTag.stderr);

  const remoteTag = spawnSync(
    'git',
    [
      '--git-dir',
      fx.origin,
      'show-ref',
      '--verify',
      '--quiet',
      `refs/tags/${TAG}`,
    ],
    { env: fx.env, encoding: 'utf8' },
  );
  assert.equal(remoteTag.status, 1, remoteTag.stderr);
});

test('apply creates and pushes a signed tag through the CLI', () => {
  const fx = makeFixture();
  configureSigning(fx);
  const result = runCli(fx, [...validArgs(fx), '--apply'], true, {
    gitVersion: '2.44.0',
  });

  assert.equal(
    result.status,
    0,
    `${result.stderr}\n${result.stdout}\n${result.log}`,
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'apply');
  assert.equal(report.decision, 'create');
  assert.equal(report.created, true);
  assert.equal(report.pushAttempts, 1);
  assert.equal(report.pushed, true);

  const localObject = git(fx.env, fx.primary, [
    'rev-parse',
    `refs/tags/${TAG}`,
  ]);
  const remoteObject = git(fx.env, fx.origin, [
    'rev-parse',
    `refs/tags/${TAG}`,
  ]);
  assert.equal(remoteObject, localObject);
  git(fx.env, fx.primary, [
    '-c',
    `gpg.ssh.allowedSignersFile=${fx.allowedSigners}`,
    'verify-tag',
    localObject,
  ]);
  assert.match(
    git(fx.env, fx.primary, ['cat-file', 'tag', localObject]),
    new RegExp(`\\n\\nrelease ${TAG}\\n-----BEGIN SSH SIGNATURE-----`, 'u'),
  );
});
