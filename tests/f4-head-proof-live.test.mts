import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  claimCheckSpawnOptions,
  classifyClaimAssertResult,
  classifyLocalRefReads,
  createLiveF4HeadProofDeps,
  matchRegisteredWorktree,
  selectPullRequests,
} from '../src/scripts/f4-head-proof-live.mts';

// kurone-kito/idd-skill#4368: the pure classifiers behind the production
// wiring of the F4 head-proof flow. The `git`, `gh`, and spawn calls around
// them are thin; what they conclude from their output is tested here.

const CLAIM = '95ad0071-ebaa-4155-91ac-ceeae7897bf8';
const BRANCH = 'issue/4368-feat-post-idd-marker-add-f4-head-proof';
const TIP = 'a'.repeat(40);

function routing(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'already_owned',
    action: 'keep',
    reason: 'claim-id-match',
    active_claim: { claim_id: CLAIM, branch: BRANCH },
    ...overrides,
  });
}

test('classifyClaimAssertResult: exit 0 with an owned keep verdict for this claim is owned', () => {
  assert.deepEqual(classifyClaimAssertResult(0, routing(), CLAIM), {
    status: 'owned',
    branch: BRANCH,
  });
});

test('classifyClaimAssertResult: a non-zero exit is not-owned for every routing state and action', () => {
  for (const state of [
    'unclaimed',
    'stale',
    'non_inheritable',
    'disputed',
    'owner_evidence_required',
    'already_owned',
    'local_worktree_occupied',
  ]) {
    assert.deepEqual(
      classifyClaimAssertResult(1, routing({ state, action: 'stop' }), CLAIM),
      { status: 'not-owned' },
      state,
    );
  }
  for (const action of ['keep', 're_claim', 'stop', 'takeover']) {
    assert.deepEqual(
      classifyClaimAssertResult(
        1,
        routing({ state: 'disputed', action }),
        CLAIM,
      ),
      { status: 'not-owned' },
      action,
    );
  }
});

test('classifyClaimAssertResult: a non-zero exit with a routing verdict is not-owned', () => {
  for (const body of [
    routing({ state: 'owner_evidence_required', action: 'stop' }),
    routing({
      state: 'local_worktree_occupied',
      action: 'stop',
      active_claim: null,
    }),
    routing({ state: 'disputed', action: 'stop' }),
  ]) {
    assert.deepEqual(classifyClaimAssertResult(1, body, CLAIM), {
      status: 'not-owned',
    });
  }
});

test('classifyClaimAssertResult: output that is not a routing verdict is unreadable', () => {
  for (const [exited, stdout] of [
    [1, ''],
    [0, ''],
    [1, 'not json'],
    [0, 'null'],
    [0, '[]'],
    [1, JSON.stringify({ state: 'already_owned' })],
    [1, JSON.stringify({ action: 'keep' })],
  ] as const) {
    assert.equal(
      classifyClaimAssertResult(exited, stdout, CLAIM).status,
      'unreadable',
      `${exited} ${stdout}`,
    );
  }
});

test('classifyClaimAssertResult: a non-zero exit with a state or action outside the routing vocabulary is unreadable', () => {
  // Only the verdicts resume-claim-routing can print prove that the claim is
  // not this session's; a value it never prints does not, and holds instead.
  for (const body of [
    routing({ state: 'future_state', action: 'stop' }),
    routing({ state: 'disputed', action: 'teleport' }),
    routing({ state: 42, action: 'stop' }),
    routing({ state: 'disputed', action: 42 }),
  ]) {
    assert.equal(
      classifyClaimAssertResult(1, body, CLAIM).status,
      'unreadable',
      body,
    );
  }
});

test('classifyClaimAssertResult: an owned keep verdict with a non-zero exit was cut short, so it is unreadable', () => {
  // `--assert` exits 0 exactly for this verdict; a kill after printing it
  // must not read as a claim that is lost.
  for (const exited of [1, 2, 137]) {
    assert.equal(
      classifyClaimAssertResult(exited, routing(), CLAIM).status,
      'unreadable',
      String(exited),
    );
  }
});

test('classifyClaimAssertResult: exit 0 that does not prove this claim is unreadable, never owned', () => {
  for (const body of [
    routing({ active_claim: { claim_id: 'another-claim', branch: BRANCH } }),
    routing({ active_claim: { claim_id: CLAIM, branch: '' } }),
    routing({ active_claim: { claim_id: CLAIM } }),
    routing({ active_claim: null }),
    routing({ state: 'stale', action: 'takeover' }),
  ]) {
    const outcome = classifyClaimAssertResult(0, body, CLAIM);
    assert.equal(outcome.status, 'unreadable', body);
  }
});

test('classifyLocalRefReads: a verified full SHA is present', () => {
  assert.deepEqual(classifyLocalRefReads({ status: 0, stdout: TIP }, null), {
    state: 'present',
    tip: TIP,
  });
});

test('classifyLocalRefReads: a verified value that is not a full SHA is an error', () => {
  for (const stdout of ['', 'abc', TIP.toUpperCase(), `${TIP}0`]) {
    assert.deepEqual(classifyLocalRefReads({ status: 0, stdout }, null), {
      state: 'error',
      tip: null,
    });
  }
});

test('classifyLocalRefReads: only a show-ref exit of 1 makes a failed rev-parse an absent ref', () => {
  const failed = { status: 128, stdout: '' };
  assert.deepEqual(classifyLocalRefReads(failed, { status: 1 }), {
    state: 'absent',
    tip: null,
  });
  for (const exists of [
    { status: 0 },
    { status: 128 },
    { status: null },
    null,
  ]) {
    assert.deepEqual(classifyLocalRefReads(failed, exists), {
      state: 'error',
      tip: null,
    });
  }
});

test('selectPullRequests keeps same-repository pull requests with exactly this head branch', () => {
  const rows = [
    {
      number: 10,
      state: 'MERGED',
      headRefName: BRANCH,
      isCrossRepository: false,
    },
    {
      number: 11,
      state: 'CLOSED',
      headRefName: BRANCH,
      isCrossRepository: false,
    },
    { number: 12, state: 'OPEN', headRefName: BRANCH },
    // A fork's pull request that happens to use the same branch name.
    {
      number: 13,
      state: 'MERGED',
      headRefName: BRANCH,
      isCrossRepository: true,
    },
    {
      number: 14,
      state: 'MERGED',
      headRefName: `${BRANCH}-2`,
      isCrossRepository: false,
    },
    // Rows that cannot be used.
    { number: 'x', state: 'MERGED', headRefName: BRANCH },
    { number: 0, state: 'MERGED', headRefName: BRANCH },
    null,
    'text',
  ];
  assert.deepEqual(selectPullRequests(rows, BRANCH, 100), [
    { number: 10, merged: true },
    { number: 11, merged: false },
    { number: 12, merged: false },
  ]);
});

test('selectPullRequests throws on output that is not an array', () => {
  assert.throws(
    () => selectPullRequests({}, BRANCH, 100),
    /did not return a JSON array/,
  );
  assert.deepEqual(selectPullRequests([], BRANCH, 100), []);
});

test('matchRegisteredWorktree matches a registered worktree by real path and fails closed otherwise', () => {
  const root = mkdtempSync(join(tmpdir(), 'f4-head-proof-live-'));
  try {
    const registered = join(root, 'registered');
    const other = join(root, 'other');
    const prunable = join(root, 'prunable');
    mkdirSync(registered);
    mkdirSync(other);
    mkdirSync(prunable);
    const link = join(root, 'link-to-registered');
    symlinkSync(registered, link);
    const record = (path: string, extra: string[] = []): string =>
      [
        `worktree ${path}`,
        `HEAD ${'1'.repeat(40)}`,
        `branch refs/heads/${BRANCH}`,
        ...extra,
        '',
        '',
      ].join('\0');
    const listing = record(registered) + record(prunable, ['prunable gone']);

    assert.equal(matchRegisteredWorktree(listing, registered), true);
    // A symbolic link to a registered worktree is the same directory.
    assert.equal(matchRegisteredWorktree(listing, link), true);
    assert.equal(matchRegisteredWorktree(listing, other), false);
    // A prunable record never matches, and neither does a missing path.
    assert.equal(matchRegisteredWorktree(listing, prunable), false);
    assert.equal(
      matchRegisteredWorktree(listing, join(root, 'missing')),
      false,
    );
    assert.equal(matchRegisteredWorktree('', registered), false);
    // Output the strict parser rejects is unreadable, not "not registered".
    assert.equal(
      matchRegisteredWorktree(`${listing}worktree`, registered),
      null,
    );
    assert.equal(
      matchRegisteredWorktree(
        `worktree ${registered}\0HEAD ${'1'.repeat(40)}\0detached\0future-field x\0\0`,
        registered,
      ),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the git reads ignore Git environment overrides of the caller', () => {
  // A caller that exports GIT_DIR or GIT_WORK_TREE would otherwise make the
  // reads below describe another repository than the supplied worktree.
  const root = mkdtempSync(join(tmpdir(), 'f4-head-proof-git-env-'));
  const repo = join(root, 'repo');
  const decoy = join(root, 'decoy');
  mkdirSync(repo);
  mkdirSync(decoy);
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.test',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      },
    ).trim();
  git(repo, 'init', '-q', '-b', 'work');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
  const tip = git(repo, 'rev-parse', 'refs/heads/work');
  git(decoy, 'init', '-q', '-b', 'other');

  const savedCwd = process.cwd();
  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  };
  try {
    process.chdir(repo);
    process.env.GIT_DIR = join(decoy, '.git');
    process.env.GIT_WORK_TREE = decoy;
    const deps = createLiveF4HeadProofDeps({ owner: 'o', repo: 'r' });
    assert.deepEqual(deps.readLocalRef(repo, 'work'), {
      state: 'present',
      tip,
    });
    assert.deepEqual(deps.readLocalRef(repo, 'other'), {
      state: 'absent',
      tip: null,
    });
    assert.equal(deps.isRegisteredWorktree(repo), true);
    assert.equal(deps.isRegisteredWorktree(decoy), false);
    assert.equal(deps.isValidRefName('work'), true);
  } finally {
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('selectPullRequests refuses a list that reached the row cap, even when every row is filtered out', () => {
  const row = { number: 7, state: 'CLOSED', headRefName: BRANCH };
  const other = { number: 8, state: 'MERGED', headRefName: 'issue/other' };
  assert.deepEqual(selectPullRequests([row, row], BRANCH, 3), [
    { number: 7, merged: false },
    { number: 7, merged: false },
  ]);
  assert.throws(
    () => selectPullRequests([row, row, row], BRANCH, 3),
    /may be truncated/,
  );
  assert.throws(
    () => selectPullRequests([other, other, other], BRANCH, 3),
    /cap of 3/,
  );
});

test('the claim check runs with the sanitized Git environment, keeping PATH and the GitHub token', () => {
  const keys = ['GIT_DIR', 'GH_TOKEN', 'PATH'] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  try {
    process.env.GIT_DIR = '/decoy/.git';
    process.env.GH_TOKEN = 'token-fixture';
    const env = claimCheckSpawnOptions().env ?? {};
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GH_TOKEN, 'token-fixture');
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
