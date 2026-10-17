import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  acquireCloneLock,
  releaseCloneLock,
} from '../src/scripts/clone-lock.mts';
import type { RemoteBranchDeleteVerdict } from '../src/scripts/delete-remote-branch.mts';
import {
  claimCheckArgv,
  createLiveDeps,
  lstatKind,
  parseArgs,
  proofDryRunArgv,
} from '../src/scripts/f4-worktree-branch-cleanup.mts';
import {
  type F4WorktreeBranchDeps,
  type F4WorktreeBranchInput,
  runF4WorktreeBranchSteps,
} from '../src/scripts/f4-worktree-branch-steps.mts';
import { fixtureEnv } from './test-utils.mts';

// Real-git coverage of the F4 steps 4 to 6 helper (#4370): temporary
// repositories, a local bare origin, and the git refusals the flow classifies.
// The claim check, the proof dry run, the `gh` reads, and the remote branch
// deletion are stubbed, so no test spawns `gh` or reaches GitHub.

const CLAIM = '696739a9-a2be-4b53-9f7f-6fde6c11452e';
const AGENT = 'claude-23c12b20';
const ISSUE = 4370;
const BRANCH = 'issue/4370-feat-merge-gate-f4-worktree-branch';
const IDENTITY = {
  GIT_AUTHOR_NAME: 'f4 fixture',
  GIT_AUTHOR_EMAIL: 'f4@example.invalid',
  GIT_COMMITTER_NAME: 'f4 fixture',
  GIT_COMMITTER_EMAIL: 'f4@example.invalid',
};
const FAKE_MERGE = 'f'.repeat(40);

const tempRoots: string[] = [];
after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...fixtureEnv(), ...IDENTITY },
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function gitStatus(cwd: string, args: string[]): number {
  try {
    git(cwd, args);
    return 0;
  } catch {
    return 1;
  }
}

function writeAndCommit(repo: string, file: string, text: string): void {
  writeFileSync(join(repo, file), text);
  git(repo, ['add', '--', file]);
  git(repo, ['commit', '-q', '-m', `add ${file}`]);
}

interface Fixture {
  readonly root: string;
  readonly origin: string;
  readonly seed: string;
  readonly primary: string;
  readonly worktree: string;
}

/**
 * A bare origin, a seeded `main`, a primary clone, and the claimed worktree
 * on `BRANCH` created from `main`, as B1 would leave it.
 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'f4-cleanup-'));
  tempRoots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const primary = join(root, 'primary');
  const worktree = join(root, 'issue-4370-feat-merge-gate-f4-worktree-branch');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, seed]);
  git(seed, ['checkout', '-q', '-b', 'main']);
  writeAndCommit(seed, 'README.md', 'base\n');
  git(seed, ['push', '-q', 'origin', 'HEAD:main']);
  git(root, ['clone', '-q', origin, primary]);
  git(primary, ['checkout', '-q', 'main']);
  git(primary, ['worktree', 'add', '-q', '-b', BRANCH, worktree, 'main']);
  return { root, origin, seed, primary, worktree };
}

function tipOf(repo: string, branch: string): string {
  return git(repo, ['rev-parse', `refs/heads/${branch}`]);
}

function proofStdout(branchTip: string, head: string): string {
  return JSON.stringify({
    verdict: 'proceed',
    reason: 'reusable',
    proof: {
      pr: 1,
      claim: CLAIM,
      branch: BRANCH,
      f2: 'a'.repeat(40),
      branchTip,
      merge: FAKE_MERGE,
      head,
    },
  });
}

const CLAIM_OK = {
  exitCode: 0,
  stdout: JSON.stringify({
    state: 'already_owned',
    action: 'keep',
    reason: 'claim-id-match',
    claim_id_checked: CLAIM,
    active_claim: { agent_id: AGENT, claim_id: CLAIM, branch: BRANCH },
  }),
};

interface RunOptions {
  readonly apply?: boolean;
  readonly branchTip?: string;
  readonly head?: string;
  readonly autoDelete?: boolean;
  readonly worktree?: string;
  readonly primary?: string;
}

/**
 * Run the flow with the real git and filesystem, and stubs for everything
 * that would leave the machine. `calls` records every git invocation.
 */
function runCleanup(
  fx: Fixture,
  options: RunOptions = {},
): {
  report: ReturnType<typeof runF4WorktreeBranchSteps>;
  calls: string[][];
  remote: string[];
} {
  const worktree = options.worktree ?? fx.worktree;
  const primary = options.primary ?? fx.primary;
  const tip = options.branchTip ?? tipOf(fx.primary, BRANCH);
  const head = options.head ?? tip;
  const calls: string[][] = [];
  const remote: string[] = [];
  const live = createLiveDeps({
    issueNumber: ISSUE,
    claimId: CLAIM,
    nonce: 'nonce-for-tests',
    agentId: AGENT,
    worktree,
    primaryRoot: primary,
  });
  const deps: F4WorktreeBranchDeps = {
    ...live,
    git: (args, cwd) => {
      calls.push([...args]);
      return live.git(args, cwd);
    },
    assertClaim: () => CLAIM_OK,
    proofDryRun: () => ({ exitCode: 0, stdout: proofStdout(tip, head) }),
    prBaseRef: () => 'main',
    deleteBranchOnMerge: () => options.autoDelete ?? true,
    remoteDelete: (mode, branch, sha) => {
      remote.push(`${mode}:${branch}:${sha}`);
      const verdict: RemoteBranchDeleteVerdict = {
        protocolVersion: '1',
        decisionAuthority: 'instructions',
        mode,
        status: 'complete',
        action: mode === 'dry-run' ? 'would-delete' : 'deleted',
        branch,
        expectedSha: sha,
        observedSha: sha,
        detail: 'stubbed',
      };
      return verdict;
    },
  };
  const input: F4WorktreeBranchInput = {
    issueNumber: ISSUE,
    claimId: CLAIM,
    agentId: AGENT,
    worktree,
    primaryRoot: primary,
    apply: options.apply ?? true,
  };
  return { report: runF4WorktreeBranchSteps(input, deps), calls, remote };
}

test('a dirty untracked file holds dirty-worktree and removes nothing', () => {
  const fx = makeFixture();
  writeFileSync(join(fx.worktree, 'scratch.txt'), 'local\n');
  const { report } = runCleanup(fx);
  assert.equal(report.reason, 'dirty-worktree');
  assert.equal(existsSync(join(fx.worktree, 'scratch.txt')), true);
  assert.equal(existsSync(fx.worktree), true);
  assert.equal(tipOf(fx.primary, BRANCH).length, 40);
});

test('a modified tracked file holds dirty-worktree and keeps the worktree', () => {
  const fx = makeFixture();
  writeFileSync(join(fx.worktree, 'README.md'), 'changed\n');
  const { report } = runCleanup(fx);
  assert.equal(report.reason, 'dirty-worktree');
  assert.equal(existsSync(join(fx.worktree, 'README.md')), true);
});

test('an ignored file holds dirty-worktree, since git would delete it silently', () => {
  const fx = makeFixture();
  writeFileSync(join(fx.worktree, '.gitignore'), 'build/\n');
  git(fx.worktree, ['add', '--', '.gitignore']);
  git(fx.worktree, ['commit', '-q', '-m', 'ignore build']);
  mkdirSync(join(fx.worktree, 'build'));
  writeFileSync(join(fx.worktree, 'build', 'out.bin'), 'x');
  const { report } = runCleanup(fx, { branchTip: tipOf(fx.worktree, BRANCH) });
  assert.equal(report.reason, 'dirty-worktree');
  assert.equal(existsSync(join(fx.worktree, 'build', 'out.bin')), true);
});

test('a populated submodule holds submodule-worktree and keeps the worktree', () => {
  const fx = makeFixture();
  const sub = join(fx.root, 'lib-source');
  mkdirSync(sub);
  git(sub, ['init', '-q', '-b', 'main']);
  writeAndCommit(sub, 'lib.txt', 'lib\n');
  git(fx.worktree, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    sub,
    'vendor/lib',
  ]);
  git(fx.worktree, ['commit', '-q', '-m', 'add submodule']);
  const { report } = runCleanup(fx, { branchTip: tipOf(fx.worktree, BRANCH) });
  assert.equal(report.reason, 'submodule-worktree');
  assert.equal(existsSync(fx.worktree), true);
});

test('a symlink at the worktree path holds before any git call touches it', () => {
  const fx = makeFixture();
  const link = join(fx.root, 'link-to-worktree');
  symlinkSync(fx.worktree, link);
  const { report, calls } = runCleanup(fx, { worktree: link });
  assert.equal(report.reason, 'symlink-path');
  assert.equal(
    calls.some((args) => args.some((arg) => arg.includes(link))),
    false,
    'no git call names the symlinked path',
  );
  assert.equal(existsSync(fx.worktree), true);
});

test('a tracked symlink to a directory outside the worktree is left untouched', () => {
  const fx = makeFixture();
  const outside = join(fx.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'do not touch\n');
  symlinkSync(outside, join(fx.worktree, 'escape'));
  git(fx.worktree, ['add', '--', 'escape']);
  git(fx.worktree, ['commit', '-q', '-m', 'track escape']);
  const { report } = runCleanup(fx, { branchTip: tipOf(fx.worktree, BRANCH) });
  assert.equal(report.reason, 'symlink-path');
  assert.equal(
    readFileSync(join(outside, 'keep.txt'), 'utf8'),
    'do not touch\n',
  );
  assert.equal(existsSync(fx.worktree), true);
});

test('a tracked symlink that stays inside the worktree does not hold', () => {
  const fx = makeFixture();
  symlinkSync('README.md', join(fx.worktree, 'alias'));
  git(fx.worktree, ['add', '--', 'alias']);
  git(fx.worktree, ['commit', '-q', '-m', 'track alias']);
  const { report } = runCleanup(fx, { branchTip: tipOf(fx.worktree, BRANCH) });
  assert.equal(report.status, 'complete');
});

test('a skip-worktree file with local changes holds dirty-worktree', () => {
  const fx = makeFixture();
  writeFileSync(join(fx.worktree, 'README.md'), 'hidden change\n');
  git(fx.worktree, ['update-index', '--skip-worktree', '--', 'README.md']);
  const { report } = runCleanup(fx);
  assert.equal(report.reason, 'dirty-worktree');
  assert.equal(
    readFileSync(join(fx.worktree, 'README.md'), 'utf8'),
    'hidden change\n',
  );
});

test('a switch never overwrites an ignored file that the development branch tracks', () => {
  const fx = makeFixture();
  // The development branch gains a tracked ign.txt upstream.
  writeFileSync(join(fx.seed, 'ign.txt'), 'tracked upstream\n');
  git(fx.seed, ['add', '--', 'ign.txt']);
  git(fx.seed, ['commit', '-q', '-m', 'track ign.txt']);
  git(fx.seed, ['push', '-q', 'origin', 'HEAD:main']);
  // The local development branch must track the file, so the switch is the
  // step that would overwrite it. The scratch branch predates the file.
  git(fx.primary, ['pull', '-q', '--ff-only', 'origin', 'main']);
  git(fx.primary, ['switch', '-q', '-c', 'scratch', 'HEAD~1']);
  writeFileSync(join(fx.primary, '.git', 'info', 'exclude'), 'ign.txt\n');
  writeFileSync(join(fx.primary, 'ign.txt'), 'local ignored\n');
  const { report } = runCleanup(fx);
  assert.equal(report.reason, 'primary-ignored-overwrite');
  assert.equal(
    readFileSync(join(fx.primary, 'ign.txt'), 'utf8'),
    'local ignored\n',
  );
  assert.equal(existsSync(fx.worktree), true);
});

test('a symlink chain that climbs out of the worktree holds symlink-path', () => {
  const fx = makeFixture();
  symlinkSync('.', join(fx.worktree, 'q'));
  mkdirSync(join(fx.worktree, 'p'));
  symlinkSync('../q/..', join(fx.worktree, 'p', 's'));
  git(fx.worktree, ['add', '--', 'q', 'p/s']);
  git(fx.worktree, ['commit', '-q', '-m', 'track a climbing symlink chain']);
  const { report } = runCleanup(fx, { branchTip: tipOf(fx.worktree, BRANCH) });
  assert.equal(report.reason, 'symlink-path');
  assert.equal(existsSync(fx.worktree), true);
});

test('the real-git flow removes the worktree and branch, and fast-forwards the primary', () => {
  const fx = makeFixture();
  const other = join(fx.root, 'issue-9999-other');
  git(fx.primary, [
    'worktree',
    'add',
    '-q',
    '-b',
    'issue/9999-other',
    other,
    'main',
  ]);
  writeAndCommit(fx.seed, 'next.txt', 'next\n');
  git(fx.seed, ['push', '-q', 'origin', 'HEAD:main']);
  const { report, calls } = runCleanup(fx);
  assert.equal(report.status, 'complete');
  assert.equal(
    calls.some((args) => args.includes('--force')),
    false,
    'no git call carries --force',
  );
  assert.equal(existsSync(fx.worktree), false);
  assert.equal(
    gitStatus(fx.primary, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${BRANCH}`,
    ]),
    1,
  );
  assert.equal(
    git(fx.primary, ['rev-parse', 'HEAD']),
    git(fx.primary, ['rev-parse', 'origin/main']),
    'the primary fast-forwarded to origin/main',
  );
  assert.equal(existsSync(other), true, 'an unrelated worktree is untouched');
  assert.equal(
    gitStatus(fx.primary, [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/issue/9999-other',
    ]),
    0,
  );
});

test('a dry run changes neither the primary nor the worktree', () => {
  const fx = makeFixture();
  writeAndCommit(fx.seed, 'next.txt', 'next\n');
  git(fx.seed, ['push', '-q', 'origin', 'HEAD:main']);
  const before = git(fx.primary, ['rev-parse', 'HEAD']);
  const { report, calls } = runCleanup(fx, { apply: false });
  assert.equal(report.status, 'dry-run');
  assert.equal(git(fx.primary, ['rev-parse', 'HEAD']), before);
  assert.equal(existsSync(fx.worktree), true);
  assert.equal(
    calls.some((args) => args[0] === 'worktree' && args[1] === 'remove'),
    false,
  );
});

test('a diverged primary holds development-branch-diverged', () => {
  const fx = makeFixture();
  writeAndCommit(fx.primary, 'local.txt', 'local\n');
  writeAndCommit(fx.seed, 'upstream.txt', 'upstream\n');
  git(fx.seed, ['push', '-q', 'origin', 'HEAD:main']);
  const { report } = runCleanup(fx);
  assert.equal(report.reason, 'development-branch-diverged');
  assert.equal(existsSync(fx.worktree), true);
});

test('a dirty tracked file that the merge overwrites holds primary-worktree-dirty', () => {
  const fx = makeFixture();
  writeFileSync(join(fx.primary, 'README.md'), 'mine\n');
  writeAndCommit(fx.seed, 'README.md', 'upstream\n');
  git(fx.seed, ['push', '-q', 'origin', 'HEAD:main']);
  const { report } = runCleanup(fx);
  assert.equal(report.reason, 'primary-worktree-dirty');
});

test('an ignored file the merge would overwrite holds primary-ignored-overwrite', () => {
  const fx = makeFixture();
  writeFileSync(join(fx.primary, '.gitignore'), 'ign.txt\n');
  writeFileSync(join(fx.primary, 'ign.txt'), 'local ignored\n');
  git(fx.primary, ['add', '--', '.gitignore']);
  git(fx.primary, ['commit', '-q', '-m', 'ignore ign.txt']);
  git(fx.primary, ['push', '-q', 'origin', 'HEAD:main']);
  git(fx.seed, ['pull', '-q', 'origin', 'main']);
  // The seed's .gitignore ignores ign.txt too, so the upstream copy is forced in.
  writeFileSync(join(fx.seed, 'ign.txt'), 'tracked upstream\n');
  git(fx.seed, ['add', '-f', '--', 'ign.txt']);
  git(fx.seed, ['commit', '-q', '-m', 'track ign.txt upstream']);
  git(fx.seed, ['push', '-q', 'origin', 'HEAD:main']);
  const { report } = runCleanup(fx);
  assert.equal(report.reason, 'primary-ignored-overwrite');
  assert.equal(
    readFileSync(join(fx.primary, 'ign.txt'), 'utf8'),
    'local ignored\n',
  );
});

test('a development branch checked out in another worktree holds development-branch-in-use', () => {
  const fx = makeFixture();
  const holder = join(fx.root, 'holder');
  // The primary moves off main onto a scratch branch, so a second worktree
  // can hold main, which is the development branch the flow must switch to.
  git(fx.primary, ['switch', '-q', '-c', 'scratch']);
  git(fx.primary, ['worktree', 'add', '-q', holder, 'main']);
  const { report } = runCleanup(fx);
  assert.equal(report.reason, 'development-branch-in-use');
  assert.match(
    report.steps.find((entry) => entry.step === 'step-4')?.detail ?? '',
    /holder/u,
  );
});

test('a refused branch delete keeps the branch when the tip equals the proof head', () => {
  const fx = makeFixture();
  writeAndCommit(fx.worktree, 'feature.txt', 'feature\n');
  const tip = tipOf(fx.worktree, BRANCH);
  const { report } = runCleanup(fx, { branchTip: tip, head: tip });
  assert.equal(report.status, 'complete');
  assert.equal(
    gitStatus(fx.primary, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${BRANCH}`,
    ]),
    0,
  );
});

test('a refused branch delete with another head holds local-branch-unmerged-commits', () => {
  const fx = makeFixture();
  writeAndCommit(fx.worktree, 'feature.txt', 'feature\n');
  const tip = tipOf(fx.worktree, BRANCH);
  const { report } = runCleanup(fx, { branchTip: tip, head: 'e'.repeat(40) });
  assert.equal(report.reason, 'local-branch-unmerged-commits');
});

test('both absent skips the removal and deletes only the merged branch', () => {
  const fx = makeFixture();
  git(fx.primary, ['worktree', 'remove', fx.worktree]);
  const { report, calls } = runCleanup(fx);
  assert.equal(report.status, 'complete');
  assert.equal(
    calls.some((args) => args[0] === 'worktree' && args[1] === 'remove'),
    false,
  );
  assert.equal(
    gitStatus(fx.primary, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${BRANCH}`,
    ]),
    1,
  );
});

test('lstatKind reads a symlink without following it', () => {
  const fx = makeFixture();
  const link = join(fx.root, 'probe-link');
  symlinkSync(fx.worktree, link);
  assert.equal(lstatKind(link), 'symlink');
  assert.equal(lstatKind(fx.worktree), 'directory');
  assert.equal(lstatKind(join(fx.root, 'missing')), 'absent');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test('the proof dry run never carries --apply, so the helper never posts a proof', () => {
  const argv = proofDryRunArgv(
    { issueNumber: ISSUE, claimId: CLAIM, agentId: AGENT },
    '/work/wt',
    '/root',
  );
  assert.equal(argv.includes('--apply'), false);
  assert.deepEqual(argv.slice(1, 9), [
    '--type',
    'f4-head-proof',
    '--target',
    'issue',
    String(ISSUE),
    '--agent-id',
    AGENT,
    '--claim-id',
  ]);
});

test('the claim check asserts with the nonce and the claimed worktree', () => {
  const argv = claimCheckArgv(
    { issueNumber: ISSUE, claimId: CLAIM, nonce: 'nonce-x' },
    '/work/wt',
    'owner',
    'repo',
    '/root',
  );
  assert.ok(argv.includes('--assert'));
  assert.equal(argv[argv.indexOf('--nonce') + 1], 'nonce-x');
  assert.equal(argv[argv.indexOf('--worktree') + 1], '/work/wt');
  assert.equal(argv.includes('--apply'), false);
});

test('parseArgs takes the flags and refuses a relative worktree, a bad issue, or no nonce', () => {
  const base = [
    '--issue',
    String(ISSUE),
    '--claim-id',
    CLAIM,
    '--nonce',
    'n',
    '--agent-id',
    AGENT,
    '--worktree',
    '/work/wt',
  ];
  assert.equal(parseArgs(base).apply, false);
  assert.equal(parseArgs([...base, '--apply']).apply, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() =>
    parseArgs([
      '--issue',
      String(ISSUE),
      '--claim-id',
      CLAIM,
      '--nonce',
      'n',
      '--agent-id',
      AGENT,
      '--worktree',
      'relative/wt',
    ]),
  );
  assert.throws(() =>
    parseArgs([
      '--issue',
      '0',
      '--claim-id',
      CLAIM,
      '--nonce',
      'n',
      '--agent-id',
      AGENT,
      '--worktree',
      '/work/wt',
    ]),
  );
  assert.throws(() =>
    parseArgs([
      '--issue',
      String(ISSUE),
      '--claim-id',
      CLAIM,
      '--agent-id',
      AGENT,
      '--worktree',
      '/work/wt',
    ]),
  );
});

test('the clone lock is released after a run that holds at step 5', () => {
  const fx = makeFixture();
  writeFileSync(join(fx.worktree, 'scratch.txt'), 'local\n');
  const { report } = runCleanup(fx);
  assert.equal(report.reason, 'dirty-worktree');
  const handle = acquireCloneLock(fx.primary, 'release-probe', 5000);
  releaseCloneLock(handle);
});
