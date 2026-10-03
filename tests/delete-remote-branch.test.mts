import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  GitCommandResult,
  GitCommandRunner,
} from '../src/scripts/delete-remote-branch.mts';
import {
  parseArgs,
  runRemoteBranchDelete,
} from '../src/scripts/delete-remote-branch.mts';

const EXPECTED = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BRANCH = 'issue/3739-digest-proof';
const BRANCH_REF = `refs/heads/${BRANCH}`;

function result(
  status: number | null,
  stdout = '',
  stderr = '',
): GitCommandResult {
  return { status, stdout, stderr };
}

function scriptedGit(results: GitCommandResult[]): {
  git: GitCommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    git: (args) => {
      calls.push(args);
      const next = results.shift();
      assert.ok(next, `unexpected git invocation: ${args.join(' ')}`);
      return next;
    },
  };
}

function present(sha = EXPECTED): GitCommandResult {
  return result(0, `${sha}\t${BRANCH_REF}\n`);
}

function defaultBranch(name = 'main'): GitCommandResult {
  return result(0, `ref: refs/heads/${name}\tHEAD\n${OTHER}\tHEAD\n`);
}

test('parseArgs requires full SHA input and exposes dry-run by default', () => {
  assert.deepEqual(
    parseArgs(['--branch', BRANCH, '--expected-sha', EXPECTED]),
    {
      help: false,
      branch: BRANCH,
      expectedSha: EXPECTED,
      apply: false,
    },
  );
  assert.throws(
    () => parseArgs(['--branch', BRANCH, '--expected-sha', 'abc']),
    /--expected-sha must be a full 40-character lowercase hexadecimal value/,
  );
});

test('an invalid expected SHA stops before invoking Git', () => {
  const { git, calls } = scriptedGit([]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: 'abc', apply: true },
    git,
  );
  assert.equal(verdict.action, 'invalid-expected-sha');
  assert.equal(verdict.status, 'hold');
  assert.deepEqual(calls, []);
});

test('an invalid branch ref stops before reading or mutating origin', () => {
  const { git, calls } = scriptedGit([result(1, '', 'invalid ref')]);
  const verdict = runRemoteBranchDelete(
    { branch: 'bad;name', expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'invalid-ref');
  assert.equal(verdict.status, 'hold');
  assert.deepEqual(calls, [['check-ref-format', 'refs/heads/bad;name']]);
});

test('an absent remote branch is complete without issuing a delete', () => {
  const { git, calls } = scriptedGit([result(0), result(0)]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'already-absent');
  assert.equal(verdict.status, 'complete');
  assert.deepEqual(calls, [
    ['check-ref-format', BRANCH_REF],
    ['ls-remote', '--refs', 'origin', BRANCH_REF],
  ]);
});

test('a remote lookup failure holds before checking or deleting another ref', () => {
  const { git, calls } = scriptedGit([result(0), result(128, '', 'offline')]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'remote-read-failed');
  assert.equal(verdict.status, 'hold');
  assert.deepEqual(calls, [
    ['check-ref-format', BRANCH_REF],
    ['ls-remote', '--refs', 'origin', BRANCH_REF],
  ]);
});

test('an unexpected remote ref response fails closed', () => {
  const { git } = scriptedGit([
    result(0),
    result(0, `${EXPECTED}\trefs/heads/another-branch\n`),
  ]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'remote-read-failed');
  assert.equal(verdict.status, 'hold');
});

test('a remote SHA mismatch holds without checking or deleting another tip', () => {
  const { git, calls } = scriptedGit([result(0), present(OTHER)]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'remote-sha-mismatch');
  assert.equal(verdict.observedSha, OTHER);
  assert.equal(calls.length, 2);
});

test('dry-run checks the default branch and never invokes git push', () => {
  const { git, calls } = scriptedGit([result(0), present(), defaultBranch()]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: false },
    git,
  );
  assert.equal(verdict.action, 'would-delete');
  assert.equal(verdict.status, 'complete');
  assert.deepEqual(calls, [
    ['check-ref-format', BRANCH_REF],
    ['ls-remote', '--refs', 'origin', BRANCH_REF],
    ['ls-remote', '--symref', 'origin', 'HEAD'],
  ]);
});

test('the remote default branch is never eligible for deletion', () => {
  const { git, calls } = scriptedGit([
    result(0),
    result(0, `${EXPECTED}\trefs/heads/main\n`),
    defaultBranch(),
  ]);
  const verdict = runRemoteBranchDelete(
    { branch: 'main', expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'default-branch-refused');
  assert.equal(verdict.status, 'hold');
  assert.equal(calls.length, 3);
});

test('an unreadable default branch fails closed before the delete', () => {
  const { git, calls } = scriptedGit([
    result(0),
    present(),
    result(0, `${OTHER}\tHEAD\n`),
  ]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'default-branch-unverified');
  assert.equal(verdict.status, 'hold');
  assert.equal(calls.length, 3);
});

test('apply uses one expected-SHA lease and confirms remote absence', () => {
  const { git, calls } = scriptedGit([
    result(0),
    present(),
    defaultBranch(),
    result(0),
    result(0),
  ]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'deleted');
  assert.equal(verdict.status, 'complete');
  assert.deepEqual(calls[3], [
    'push',
    `--force-with-lease=${BRANCH_REF}:${EXPECTED}`,
    'origin',
    `:${BRANCH_REF}`,
  ]);
  assert.deepEqual(calls[4], ['ls-remote', '--refs', 'origin', BRANCH_REF]);
});

test('a failed delete is not retried and a concurrent new tip is left untouched', () => {
  const { git, calls } = scriptedGit([
    result(0),
    present(),
    defaultBranch(),
    result(1, '', 'stale lease'),
    present(OTHER),
  ]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'remote-changed');
  assert.equal(verdict.observedSha, OTHER);
  assert.equal(calls.filter(([command]) => command === 'push').length, 1);
});

test('a failed delete with the expected ref still present holds without retry', () => {
  const { git, calls } = scriptedGit([
    result(0),
    present(),
    defaultBranch(),
    result(1, '', 'permission denied'),
    present(),
  ]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'delete-failed');
  assert.equal(verdict.status, 'hold');
  assert.equal(calls.filter(([command]) => command === 'push').length, 1);
});

test('a successful push with the remote ref still present is inconclusive', () => {
  const { git } = scriptedGit([
    result(0),
    present(),
    defaultBranch(),
    result(0),
    present(),
  ]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'deletion-unconfirmed');
  assert.equal(verdict.status, 'hold');
});

test('an unreadable post-delete state holds without retrying the mutation', () => {
  const { git, calls } = scriptedGit([
    result(0),
    present(),
    defaultBranch(),
    result(0),
    result(128, '', 'offline'),
  ]);
  const verdict = runRemoteBranchDelete(
    { branch: BRANCH, expectedSha: EXPECTED, apply: true },
    git,
  );
  assert.equal(verdict.action, 'deletion-unconfirmed');
  assert.equal(verdict.status, 'hold');
  assert.equal(calls.filter(([command]) => command === 'push').length, 1);
});
