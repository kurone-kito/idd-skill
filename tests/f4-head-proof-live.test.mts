import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  classifyClaimAssertResult,
  classifyLocalRefReads,
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

test('classifyClaimAssertResult: a non-zero exit with a routing verdict is not-owned', () => {
  for (const body of [
    routing({ state: 'owner_evidence_required', action: 'stop' }),
    routing({ state: 'claim_lost', action: 'stop', active_claim: null }),
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
  assert.deepEqual(selectPullRequests(rows, BRANCH), [
    { number: 10, merged: true },
    { number: 11, merged: false },
    { number: 12, merged: false },
  ]);
});

test('selectPullRequests throws on output that is not an array', () => {
  assert.throws(
    () => selectPullRequests({}, BRANCH),
    /did not return a JSON array/,
  );
  assert.deepEqual(selectPullRequests([], BRANCH), []);
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
