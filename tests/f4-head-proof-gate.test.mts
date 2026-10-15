import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderF4HeadProofBody } from '../src/scripts/f4-head-proof.mts';
import {
  type ClaimAssertRequest,
  collectTrustedMarkers,
  type F4HeadProofGateDeps,
  type F4HeadProofGateInput,
  type F4HeadProofGateOutcome,
  type F4HeadProofOutput,
  findClaimActivationTime,
  provesNothingSent,
  runF4HeadProofGate,
} from '../src/scripts/f4-head-proof-gate.mts';
import { createLoadControlRefusal } from '../src/scripts/github-api-refusal.mts';
import {
  parseArgs,
  runF4HeadProofCommand,
} from '../src/scripts/post-idd-marker.mts';
import {
  renderClaimedByMarker,
  renderReviewWatermarkMarker,
} from '../src/scripts/protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  type GithubProviderAdapterDeps,
} from '../src/scripts/provider-adapter-github.mts';
import type { ProviderComment } from '../src/scripts/provider-port.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

// kurone-kito/idd-skill#4368: the flow behind `post-idd-marker --type
// f4-head-proof`, driven with fake callbacks so each verdict row, each
// uncertain-write outcome, and each refused read is a plain scenario.

const ISSUE = 4368;
const PR = 4390;
const CLAIM = '95ad0071-ebaa-4155-91ac-ceeae7897bf8';
const AGENT = 'claude-826e09f0';
const BRANCH = 'issue/4368-feat-post-idd-marker-add-f4-head-proof';
const WORKTREE = '/work/idd-skill.issue-4368';
const NONCE = '0bf1174a-06d9-4e4e-ac06-97bdbd8f4a92';
const BOT = 'kurone-kito';
const F2 = '1'.repeat(40);
const TIP = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const HEAD = '4'.repeat(40);
const BASE_PARENT = '5'.repeat(40);
const ACTIVATED = '2026-10-15T15:35:44Z';
const AFTER_ACTIVATION = '2026-10-16T01:00:00Z';

const INPUT: F4HeadProofGateInput = {
  issueNumber: ISSUE,
  claimId: CLAIM,
  agentId: AGENT,
  worktree: WORKTREE,
  apply: false,
};
const APPLY: F4HeadProofGateInput = { ...INPUT, apply: true };

function comment(
  id: number,
  body: string,
  extra: Partial<ProviderComment> = {},
): ProviderComment {
  return {
    id,
    nodeId: `node-${id}`,
    body,
    createdAt: AFTER_ACTIVATION,
    updatedAt: AFTER_ACTIVATION,
    authorLogin: BOT,
    lastEditedAt: null,
    ...extra,
  };
}

function claimComment(
  id = 1,
  extra: Partial<ProviderComment> = {},
): ProviderComment {
  return comment(
    id,
    renderClaimedByMarker({
      agentId: AGENT,
      claimId: CLAIM,
      supersedes: 'none',
      timestamp: ACTIVATED,
      branch: BRANCH,
    }),
    { createdAt: ACTIVATED, updatedAt: ACTIVATED, ...extra },
  );
}

function watermarkComment(
  id = 50,
  extra: Partial<ProviderComment> = {},
  claimId = CLAIM,
): ProviderComment {
  return comment(
    id,
    renderReviewWatermarkMarker({
      agentId: AGENT,
      claimId,
      headSha: F2,
      maxActivityAt: 'none',
      totalItemCount: '0',
      ciCompletedAt: 'none',
    }),
    extra,
  );
}

function proofBody(overrides: Partial<Record<string, string>> = {}): string {
  return renderF4HeadProofBody({
    pr: String(PR),
    claim: CLAIM,
    branch: BRANCH,
    f2: F2,
    branchTip: TIP,
    merge: MERGE,
    head: HEAD,
    agentId: AGENT,
    ...overrides,
  });
}

const EXPECTED_BODY = proofBody();

interface Harness {
  deps: F4HeadProofGateDeps;
  calls: string[];
  posts: string[];
  sleeps: number[];
  /** Comments the issue read returns; a successful POST appends to it. */
  issueComments: ProviderComment[];
}

/** A fully consistent state whose verdict is `post`; override one read per scenario. */
function harness(overrides: Partial<F4HeadProofGateDeps> = {}): Harness {
  const state: Harness = {
    deps: undefined as unknown as F4HeadProofGateDeps,
    calls: [],
    posts: [],
    sleeps: [],
    issueComments: [claimComment()],
  };
  const track =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      state.calls.push(name);
      return fn(...args);
    };
  state.deps = {
    isRegisteredWorktree: track('isRegisteredWorktree', () => true),
    readTokens: track('readTokens', () => ({
      status: 'present' as const,
      path: '/tokens',
      record: {
        agentId: AGENT,
        claimId: CLAIM,
        nonce: NONCE,
        recordedAt: ACTIVATED,
      },
    })),
    checkLock: track('checkLock', () => ({
      path: '/lock',
      present: true,
      holder: { agentId: AGENT, claimId: CLAIM, acquiredAt: ACTIVATED },
    })),
    assertClaim: track(
      'assertClaim',
      (_request: ClaimAssertRequest) =>
        ({ status: 'owned', branch: BRANCH }) as const,
    ),
    resolveTrustedLogins: track('resolveTrustedLogins', () => [BOT]),
    listIssueComments: track('listIssueComments', () => [
      ...state.issueComments,
    ]),
    listPullRequests: track('listPullRequests', () => [
      { number: PR, merged: true },
    ]),
    listPullRequestComments: track('listPullRequestComments', () => [
      watermarkComment(),
    ]),
    readPullRequest: track('readPullRequest', () => ({
      state: 'closed',
      merged: true,
      mergeCommitSha: MERGE,
      headSha: HEAD,
    })),
    readCommit: track('readCommit', () => ({
      sha: MERGE,
      parents: [BASE_PARENT, HEAD],
    })),
    isValidRefName: track('isValidRefName', () => true),
    readLocalRef: track('readLocalRef', () => ({
      state: 'present' as const,
      tip: TIP,
    })),
    postComment: track('postComment', (_issue: number, body: string) => {
      state.posts.push(body);
      state.issueComments.push(
        comment(9001, body, {
          createdAt: AFTER_ACTIVATION,
          updatedAt: AFTER_ACTIVATION,
        }),
      );
      return { id: 9001, htmlUrl: 'https://example.test/9001' };
    }),
    sleep: track('sleep', (ms: number) => {
      state.sleeps.push(ms);
    }),
    ...overrides,
  };
  return state;
}

function verdictOf(outcome: F4HeadProofGateOutcome): {
  exitCode: 0 | 1;
  output: F4HeadProofOutput;
} {
  assert.equal(outcome.kind, 'verdict', JSON.stringify(outcome));
  if (outcome.kind !== 'verdict') {
    throw new Error('unreachable');
  }
  return outcome;
}

function expectVerdict(
  outcome: F4HeadProofGateOutcome,
  verdict: string,
  reason: string | null,
  exitCode: 0 | 1,
): F4HeadProofOutput {
  const result = verdictOf(outcome);
  assert.equal(result.output.verdict, verdict, JSON.stringify(result.output));
  assert.equal(result.output.reason, reason);
  assert.equal(result.exitCode, exitCode);
  return result.output;
}

function statusError(status: number): Error {
  const error = new Error(`gh: request failed (HTTP ${status})`);
  Object.defineProperty(error, 'stderr', {
    value: `gh: request failed (HTTP ${status})`,
  });
  return error;
}

// --- dry run ---------------------------------------------------------------

test('a dry run reads the live state, names the post verdict with a null reason, and posts nothing', () => {
  const h = harness();
  const output = expectVerdict(
    runF4HeadProofGate(INPUT, h.deps),
    'post',
    null,
    0,
  );
  assert.equal(output.mode, 'dry-run');
  assert.equal(output.type, 'f4-head-proof');
  assert.equal(output.target, 'issue');
  assert.equal(output.number, ISSUE);
  assert.equal(output.body, EXPECTED_BODY);
  assert.deepEqual(output.proof, {
    pr: PR,
    claim: CLAIM,
    branch: BRANCH,
    f2: F2,
    branchTip: TIP,
    merge: MERGE,
    head: HEAD,
  });
  assert.deepEqual(h.posts, []);
  for (const read of [
    'readTokens',
    'assertClaim',
    'checkLock',
    'listIssueComments',
    'listPullRequests',
    'readPullRequest',
    'readCommit',
    'readLocalRef',
    'listPullRequestComments',
  ]) {
    assert.ok(h.calls.includes(read), `a dry run should call ${read}`);
  }
  assert.ok(!h.calls.includes('postComment'));
});

test('the claim check receives the stored nonce, the claim ID, and the worktree', () => {
  const requests: ClaimAssertRequest[] = [];
  const h = harness({
    assertClaim: (request) => {
      requests.push(request);
      return { status: 'owned', branch: BRANCH };
    },
  });
  runF4HeadProofGate(INPUT, h.deps);
  assert.deepEqual(requests, [
    {
      issueNumber: ISSUE,
      claimId: CLAIM,
      nonce: NONCE,
      worktree: WORKTREE,
    },
  ]);
});

// --- worktree registration -------------------------------------------------

test('an unregistered worktree is refused before any claim read', () => {
  const h = harness({ isRegisteredWorktree: () => false });
  const outcome = runF4HeadProofGate(INPUT, h.deps);
  assert.equal(outcome.kind, 'refused');
  assert.match(
    (outcome as { message: string }).message,
    /not a worktree that git worktree list --porcelain registers/,
  );
  assert.ok(!h.calls.includes('readTokens'));
  assert.deepEqual(h.posts, []);
});

test('a worktree list that cannot be read is refused too', () => {
  const h = harness({ isRegisteredWorktree: () => null });
  const outcome = runF4HeadProofGate(INPUT, h.deps);
  assert.equal(outcome.kind, 'refused');
  assert.match((outcome as { message: string }).message, /could not be read/);
});

// --- nonce, claim check, and lock ------------------------------------------

test('a token record that is absent, malformed, or has no nonce is a hold on claim-or-lock', () => {
  const unreadable = [
    { status: 'absent' as const, path: '/tokens' },
    { status: 'malformed' as const, path: '/tokens' },
    {
      status: 'present' as const,
      path: '/tokens',
      record: { agentId: AGENT, claimId: CLAIM, recordedAt: ACTIVATED },
    },
    {
      status: 'present' as const,
      path: '/tokens',
      record: {
        agentId: AGENT,
        claimId: CLAIM,
        nonce: '  ',
        recordedAt: ACTIVATED,
      },
    },
  ];
  for (const tokens of unreadable) {
    const h = harness({ readTokens: () => tokens });
    expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'hold',
      'claim-or-lock',
      1,
    );
    assert.ok(!h.calls.includes('assertClaim'), JSON.stringify(tokens));
    assert.deepEqual(h.posts, []);
  }
});

test('a claim check that cannot be read is a hold on claim-or-lock', () => {
  const h = harness({
    assertClaim: () => ({ status: 'unreadable', detail: 'no JSON' }),
  });
  expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'hold', 'claim-or-lock', 1);
  assert.deepEqual(h.posts, []);
});

test('a claim check that says the claim is not ours is a stop on claim-or-lock', () => {
  const h = harness({ assertClaim: () => ({ status: 'not-owned' }) });
  expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'stop', 'claim-or-lock', 1);
  assert.deepEqual(h.posts, []);
  assert.ok(!h.calls.includes('listIssueComments'));
});

test('an absent lock, or a lock held by another claim ID, is a stop on claim-or-lock', () => {
  const locks = [
    { path: '/lock', present: false },
    {
      path: '/lock',
      present: true,
      holder: {
        agentId: AGENT,
        claimId: 'another-claim',
        acquiredAt: ACTIVATED,
      },
    },
  ];
  for (const lock of locks) {
    const h = harness({ checkLock: () => lock });
    expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'stop',
      'claim-or-lock',
      1,
    );
    assert.deepEqual(h.posts, []);
  }
});

test('a malformed lock is a hold on claim-or-lock', () => {
  const h = harness({
    checkLock: () => ({ path: '/lock', present: true, malformed: true }),
  });
  expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'hold', 'claim-or-lock', 1);
});

// --- decideBeforePost hold reasons -----------------------------------------

test('pr-state: no merged pull request for the branch', () => {
  for (const found of [
    [],
    [{ number: PR, merged: false }],
    [
      { number: PR, merged: true },
      { number: PR + 1, merged: true },
    ],
  ]) {
    const h = harness({ listPullRequests: () => found });
    expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'hold', 'pr-state', 1);
    assert.deepEqual(h.posts, []);
  }
  const failing = harness({
    listPullRequests: () => {
      throw new Error('gh pr list failed');
    },
  });
  expectVerdict(runF4HeadProofGate(APPLY, failing.deps), 'hold', 'pr-state', 1);
});

test('pr-state: an unmerged, unreadable, or malformed pull request', () => {
  const cases: Partial<F4HeadProofGateDeps>[] = [
    {
      readPullRequest: () => ({
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        headSha: HEAD,
      }),
    },
    {
      readPullRequest: () => ({
        state: 'closed',
        merged: false,
        mergeCommitSha: null,
        headSha: HEAD,
      }),
    },
    {
      readPullRequest: () => ({
        state: 'closed',
        merged: true,
        mergeCommitSha: 'abc123',
        headSha: HEAD,
      }),
    },
    {
      readPullRequest: () => ({
        state: 'closed',
        merged: true,
        mergeCommitSha: MERGE,
        headSha: null,
      }),
    },
    {
      readPullRequest: () => {
        throw new Error('HTTP 500');
      },
    },
  ];
  for (const override of cases) {
    const h = harness(override);
    expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'hold', 'pr-state', 1);
    assert.deepEqual(h.posts, []);
  }
});

test('pr-state: the commit endpoint is read only after the pull request passes', () => {
  const h = harness({
    readPullRequest: () => ({
      state: 'open',
      merged: false,
      mergeCommitSha: MERGE,
      headSha: HEAD,
    }),
  });
  runF4HeadProofGate(APPLY, h.deps);
  assert.ok(!h.calls.includes('readCommit'));
});

test('pr-state: a merge commit with an unusable parent list', () => {
  const parentCases: Partial<F4HeadProofGateDeps>[] = [
    { readCommit: () => ({ sha: MERGE, parents: [] }) },
    {
      readCommit: () => ({
        sha: MERGE,
        parents: [BASE_PARENT, HEAD, TIP],
      }),
    },
    // Two parents whose second parent is not the live head.
    { readCommit: () => ({ sha: MERGE, parents: [HEAD, BASE_PARENT] }) },
    { readCommit: () => ({ sha: MERGE, parents: [BASE_PARENT, 'abc'] }) },
    { readCommit: () => ({ sha: MERGE, parents: [BASE_PARENT, null] }) },
    // The commit endpoint answered for another SHA.
    { readCommit: () => ({ sha: TIP, parents: [BASE_PARENT, HEAD] }) },
    {
      readCommit: () => {
        throw new Error('HTTP 502');
      },
    },
  ];
  for (const override of parentCases) {
    const h = harness(override);
    expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'hold', 'pr-state', 1);
    assert.deepEqual(h.posts, []);
  }
});

test('a one-parent merge (squash or rebase) passes and keeps the live head', () => {
  const h = harness({
    readCommit: () => ({ sha: MERGE, parents: [BASE_PARENT] }),
  });
  const output = expectVerdict(
    runF4HeadProofGate(INPUT, h.deps),
    'post',
    null,
    0,
  );
  assert.equal(output.proof.head, HEAD);
});

test('ref-read: an invalid branch name or a failed ref read', () => {
  const cases: Partial<F4HeadProofGateDeps>[] = [
    { isValidRefName: () => false },
    { readLocalRef: () => ({ state: 'error', tip: null }) },
    {
      readLocalRef: () => {
        throw new Error('git failed');
      },
    },
    // A present ref whose tip is not a full SHA is an error state too.
    { readLocalRef: () => ({ state: 'present', tip: 'abc' }) },
  ];
  for (const override of cases) {
    const h = harness(override);
    expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'hold', 'ref-read', 1);
    assert.deepEqual(h.posts, []);
  }
});

test('marker-read-failed: the issue comments cannot be read', () => {
  const h = harness({
    listIssueComments: () => {
      throw new Error('GraphQL failed');
    },
  });
  expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'hold',
    'marker-read-failed',
    1,
  );
  assert.deepEqual(h.posts, []);
});

test('marker-read-failed: the trusted logins cannot be resolved', () => {
  const h = harness({
    resolveTrustedLogins: () => {
      throw new Error('viewer lookup failed');
    },
  });
  expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'hold',
    'marker-read-failed',
    1,
  );
});

test('branch-absent: the local branch is gone and no reusable proof exists', () => {
  const h = harness({ readLocalRef: () => ({ state: 'absent', tip: null }) });
  expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'hold', 'branch-absent', 1);
  assert.deepEqual(h.posts, []);
});

test('conflicting-marker: a trusted proof that disagrees, is malformed, or was edited', () => {
  const conflicts = [
    comment(60, proofBody({ merge: '9'.repeat(40) })),
    comment(61, '<!-- idd-f4-head-proof: v2 pr=oops -->'),
    comment(62, proofBody(), { lastEditedAt: '2026-10-16T02:00:00Z' }),
    comment(63, proofBody(), { updatedAt: '2026-10-16T02:00:00Z' }),
    comment(64, proofBody(), { createdAt: '2026-10-15T00:00:00Z' }),
  ];
  for (const marker of conflicts) {
    const h = harness();
    h.issueComments.push(marker);
    expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'hold',
      'conflicting-marker',
      1,
    );
    assert.deepEqual(h.posts, [], `comment ${marker.id}`);
  }
});

test('an untrusted marker, and a trusted marker of another claim, are not conflicts', () => {
  const h = harness();
  h.issueComments.push(
    comment(70, proofBody({ merge: '9'.repeat(40) }), {
      authorLogin: 'stranger',
    }),
    comment(71, proofBody({ claim: 'another-claim', merge: '9'.repeat(40) })),
    comment(72, '<!-- idd-f4-head-proof: v2 pr=1 claim=another-claim oops -->'),
  );
  expectVerdict(runF4HeadProofGate(INPUT, h.deps), 'post', null, 0);
});

test('watermark-unauthenticated: no trusted, unedited, same-claim review-watermark', () => {
  const watermarks: ProviderComment[][] = [
    [],
    [watermarkComment(50, { authorLogin: 'stranger' })],
    [watermarkComment(50, { lastEditedAt: '2026-10-16T02:00:00Z' })],
    [watermarkComment(50, {}, 'another-claim')],
    [comment(50, 'looks good')],
  ];
  for (const comments of watermarks) {
    const h = harness({ listPullRequestComments: () => comments });
    expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'hold',
      'watermark-unauthenticated',
      1,
    );
    assert.deepEqual(h.posts, []);
  }
  const failing = harness({
    listPullRequestComments: () => {
      throw new Error('GraphQL failed');
    },
  });
  expectVerdict(
    runF4HeadProofGate(APPLY, failing.deps),
    'hold',
    'watermark-unauthenticated',
    1,
  );
});

test('claim-activation-unknown: no trusted claimed-by marker for this claim and branch', () => {
  const cases: ProviderComment[][] = [
    [],
    [claimComment(1, { authorLogin: 'stranger' })],
    [claimComment(1, { lastEditedAt: '2026-10-16T02:00:00Z' })],
    [
      comment(
        1,
        renderClaimedByMarker({
          agentId: AGENT,
          claimId: CLAIM,
          supersedes: 'none',
          timestamp: ACTIVATED,
          branch: 'issue/9-other-branch',
        }),
        { createdAt: ACTIVATED, updatedAt: ACTIVATED },
      ),
    ],
  ];
  for (const comments of cases) {
    const h = harness();
    h.issueComments.splice(0, h.issueComments.length, ...comments);
    expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'hold',
      'claim-activation-unknown',
      1,
    );
    assert.deepEqual(h.posts, []);
  }
});

// --- reusable --------------------------------------------------------------

test('reusable: an existing proof for this claim proceeds and posts nothing', () => {
  const h = harness();
  h.issueComments.push(comment(80, EXPECTED_BODY));
  const output = expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'proceed',
    'reusable',
    0,
  );
  assert.deepEqual(h.posts, []);
  assert.equal(output.proof.merge, MERGE);
});

test('reusable: duplicate identical proofs still proceed', () => {
  const h = harness();
  h.issueComments.push(
    comment(80, EXPECTED_BODY),
    comment(81, EXPECTED_BODY, {
      createdAt: '2026-10-16T01:00:05Z',
      updatedAt: '2026-10-16T01:00:05Z',
    }),
  );
  expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'proceed', 'reusable', 0);
});

test('reusable: the stored branch tip carries the proof when the local branch is gone', () => {
  const h = harness({ readLocalRef: () => ({ state: 'absent', tip: null }) });
  h.issueComments.push(comment(80, EXPECTED_BODY));
  const output = expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'proceed',
    'reusable',
    0,
  );
  assert.equal(output.proof.branchTip, TIP);
});

// --- apply: a confirmed write ----------------------------------------------

test('a confirmed write posts the rendered body once and is confirmed by one re-fetch', () => {
  const h = harness();
  const output = expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'proceed',
    'posted-confirmed',
    0,
  );
  assert.deepEqual(h.posts, [EXPECTED_BODY]);
  assert.equal(output.mode, 'apply');
  assert.equal(output.commentId, 9001);
  assert.equal(output.url, 'https://example.test/9001');
  assert.equal(output.body, undefined);
  assert.deepEqual(h.sleeps, []);
  // The pre-write read, then exactly one re-fetch.
  assert.equal(h.calls.filter((c) => c === 'listIssueComments').length, 2);
});

test('posted-disagreed: the re-fetch does not match what was posted', () => {
  const h = harness({
    postComment: (_issue, body) => {
      h.posts.push(body);
      // Another trusted writer's proof landed instead of this one.
      h.issueComments.push(comment(9001, proofBody({ merge: '9'.repeat(40) })));
      return { id: 9001, htmlUrl: 'https://example.test/9001' };
    },
  });
  const output = expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'hold',
    'posted-disagreed',
    1,
  );
  assert.equal(h.posts.length, 1);
  assert.equal(output.commentId, 9001);
  assert.match(output.nextAction ?? '', /Do not post again/);
});

test('posted-disagreed: the re-fetch fails or finds no proof', () => {
  for (const refetch of ['throws', 'empty'] as const) {
    let reads = 0;
    const h = harness({
      listIssueComments: () => {
        reads += 1;
        if (reads === 1) {
          return [claimComment()];
        }
        if (refetch === 'throws') {
          throw new Error('read failed');
        }
        return [claimComment()];
      },
    });
    expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'hold',
      'posted-disagreed',
      1,
    );
    assert.equal(h.posts.length, 1);
  }
});

// --- apply: post errors that prove nothing was sent ------------------------

test('post-rejected: a load-control refusal, or HTTP 401, 404, or 422, posts nothing more', () => {
  const rejections = [
    createLoadControlRefusal({ outcome: 'not-dispatched', reason: 'busy' }),
    statusError(401),
    statusError(404),
    statusError(422),
  ];
  for (const rejection of rejections) {
    let attempts = 0;
    const h = harness({
      postComment: () => {
        attempts += 1;
        throw rejection;
      },
    });
    const output = expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'hold',
      'post-rejected',
      1,
    );
    assert.equal(attempts, 1);
    // No re-read after the rejection: the pre-write read is the only one.
    assert.equal(h.calls.filter((c) => c === 'listIssueComments').length, 1);
    assert.match(output.nextAction ?? '', /Fix the cause/);
    assert.deepEqual(h.sleeps, []);
  }
});

test('provesNothingSent accepts only a refusal of its own or a 401, 404, or 422', () => {
  assert.equal(
    provesNothingSent(
      createLoadControlRefusal({
        outcome: 'not-dispatched',
        reason: 'cooldown',
      }),
    ),
    true,
  );
  for (const status of [401, 404, 422]) {
    assert.equal(provesNothingSent(statusError(status)), true, String(status));
  }
  for (const status of [403, 409, 500, 502]) {
    assert.equal(provesNothingSent(statusError(status)), false, String(status));
  }
  assert.equal(provesNothingSent(new Error('timed out')), false);
  assert.equal(provesNothingSent('boom'), false);
  // A wrapper that only carries a refusal in its cause chain says nothing
  // about whether its own write landed.
  const wrapper = new Error('earlier write failed', {
    cause: createLoadControlRefusal({
      outcome: 'not-dispatched',
      reason: 'busy',
    }),
  });
  assert.equal(provesNothingSent(wrapper), false);
});

// --- apply: uncertain writes -----------------------------------------------

function uncertain(): Error {
  return new Error('gh: connection reset');
}

test('post-unconfirmed: three absent re-reads after an uncertain write', () => {
  let postCalls = 0;
  const h = harness({
    postComment: () => {
      postCalls += 1;
      throw uncertain();
    },
  });
  const output = expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'hold',
    'post-unconfirmed',
    1,
  );
  // The pre-write read plus exactly three re-reads, and nothing posted again.
  assert.equal(h.calls.filter((c) => c === 'listIssueComments').length, 4);
  assert.equal(postCalls, 1);
  assert.equal(h.sleeps.length, 2);
  assert.match(output.nextAction ?? '', /Do not post again/);
});

test('reread-failed: a re-read that fails after an uncertain write', () => {
  let reads = 0;
  const h = harness({
    listIssueComments: () => {
      reads += 1;
      if (reads === 3) {
        throw new Error('read failed');
      }
      return [claimComment()];
    },
    postComment: () => {
      throw uncertain();
    },
  });
  expectVerdict(runF4HeadProofGate(APPLY, h.deps), 'hold', 'reread-failed', 1);
  assert.equal(reads, 4);
});

test('reread-conflict: the re-reads disagree', () => {
  let reads = 0;
  const h = harness({
    listIssueComments: () => {
      reads += 1;
      // Pre-write read, then none, the proof, none.
      if (reads === 3) {
        return [claimComment(), comment(9001, EXPECTED_BODY)];
      }
      return [claimComment()];
    },
    postComment: () => {
      throw uncertain();
    },
  });
  expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'hold',
    'reread-conflict',
    1,
  );
});

test('reread-conflict: a re-read finds a conflicting proof', () => {
  let reads = 0;
  const h = harness({
    listIssueComments: () => {
      reads += 1;
      return reads === 1
        ? [claimComment()]
        : [claimComment(), comment(9001, proofBody({ head: '9'.repeat(40) }))];
    },
    postComment: () => {
      throw uncertain();
    },
  });
  expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'hold',
    'reread-conflict',
    1,
  );
});

test('reread-reusable: the write landed and all three re-reads show the same proof', () => {
  let postCalls = 0;
  const h = harness({
    postComment: () => {
      postCalls += 1;
      h.posts.push(EXPECTED_BODY);
      h.issueComments.push(comment(9001, EXPECTED_BODY));
      throw uncertain();
    },
  });
  const output = expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'proceed',
    'reread-reusable',
    0,
  );
  assert.equal(postCalls, 1);
  assert.equal(output.commentId, undefined);
});

// --- the real adapter's error classes --------------------------------------

function adapterFor(overrides: Partial<GithubProviderAdapterDeps>) {
  return createGithubProviderAdapter('o', 'r', {
    ghText: () => {
      throw new Error('ghText not stubbed');
    },
    ghApiJson: () => {
      throw new Error('ghApiJson not stubbed');
    },
    resolveViewerLogin: () => BOT,
    ghTextAsync: () => {
      throw new Error('ghTextAsync not stubbed');
    },
    sleepSync: () => {},
    ...overrides,
  } as GithubProviderAdapterDeps);
}

test('each adapter error that does not prove nothing was sent is an uncertain write', () => {
  const cases: Record<string, Partial<GithubProviderAdapterDeps>> = {
    // The duplicate re-read after an ambiguous failure itself fails.
    notVerified: {
      ghText: () => {
        throw new Error('gh: connection reset');
      },
      ghApiJson: () => {
        throw new Error('read failed');
      },
    },
    // The POST answered 200 with a body that is not the one sent.
    bodyMismatch: {
      ghText: () =>
        JSON.stringify({
          id: 7,
          html_url: 'https://example.test/7',
          body: 'something else',
        }),
    },
    // The POST answered 200 without an id or URL.
    malformedResponse: { ghText: () => JSON.stringify({ body: 'x' }) },
  };
  for (const [name, transport] of Object.entries(cases)) {
    const adapter = adapterFor(transport);
    const h = harness({
      postComment: (issue, body) => {
        h.posts.push(body);
        return adapter.postWorkItemComment(issue, body);
      },
    });
    const output = expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'hold',
      'post-unconfirmed',
      1,
    );
    assert.equal(h.posts.length, 1, name);
    assert.equal(
      h.calls.filter((c) => c === 'listIssueComments').length,
      4,
      `${name}: three re-reads`,
    );
    assert.match(output.nextAction ?? '', /Do not post again/, name);
  }
});

test('the real adapter proves nothing was sent for a first-attempt 404 and for a load-control refusal', () => {
  const rejections: Error[] = [
    statusError(404),
    createLoadControlRefusal({ outcome: 'not-dispatched', reason: 'cooldown' }),
  ];
  for (const rejection of rejections) {
    const adapter = adapterFor({
      ghText: () => {
        throw rejection;
      },
    });
    const h = harness({
      postComment: (issue, body) => adapter.postWorkItemComment(issue, body),
    });
    expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'hold',
      'post-rejected',
      1,
    );
    assert.equal(h.calls.filter((c) => c === 'listIssueComments').length, 1);
  }
});

// --- the renderer ----------------------------------------------------------

test('a renderer throw posts nothing, on a dry run and under --apply', () => {
  for (const input of [INPUT, APPLY]) {
    const h = harness();
    assert.throws(
      () => runF4HeadProofGate({ ...input, agentId: 'bad agent' }, h.deps),
      /agentId must be non-empty and contain no whitespace/,
    );
    assert.deepEqual(h.posts, []);
    assert.ok(!h.calls.includes('postComment'));
  }
});

// --- parsing and trust helpers ---------------------------------------------

test('collectTrustedMarkers filters by author, claim, parse state, and edit state', () => {
  const trusted = new Set([BOT]);
  const markers = collectTrustedMarkers(
    [
      comment(1, 'no marker here'),
      comment(2, EXPECTED_BODY),
      comment(3, EXPECTED_BODY, { authorLogin: 'stranger' }),
      comment(4, proofBody({ claim: 'another-claim' })),
      comment(5, '<!-- idd-f4-head-proof: v2 broken -->'),
      comment(6, '<!-- idd-f4-head-proof: v2 claim=another-claim oops -->'),
      comment(7, EXPECTED_BODY, { lastEditedAt: '2026-10-16T02:00:00Z' }),
      comment(8, EXPECTED_BODY, { lastEditedAt: undefined }),
    ],
    CLAIM,
    trusted,
  );
  assert.deepEqual(markers, [
    {
      claimId: CLAIM,
      prNumber: PR,
      branch: BRANCH,
      merge: MERGE,
      head: HEAD,
      f2: F2,
      branchTip: TIP,
      createdAt: AFTER_ACTIVATION,
      updatedAt: AFTER_ACTIVATION,
    },
    { unparseable: true },
    { unparseable: true },
    { unparseable: true },
  ]);
});

test('findClaimActivationTime is the first trusted, unedited claimed-by of the claim and branch', () => {
  const trusted = new Set([BOT]);
  const heartbeat = claimComment(2, {
    createdAt: '2026-10-16T03:00:00Z',
    updatedAt: '2026-10-16T03:00:00Z',
  });
  const earlier = claimComment(3, {
    createdAt: '2026-10-15T12:00:00Z',
    updatedAt: '2026-10-15T12:00:00Z',
  });
  assert.equal(
    findClaimActivationTime(
      [heartbeat, claimComment(1)],
      CLAIM,
      BRANCH,
      trusted,
    ),
    ACTIVATED,
  );
  assert.equal(
    findClaimActivationTime(
      [heartbeat, claimComment(1), earlier],
      CLAIM,
      BRANCH,
      trusted,
    ),
    '2026-10-15T12:00:00Z',
  );
  // An untrusted or edited earlier marker, and another claim ID, never count.
  assert.equal(
    findClaimActivationTime(
      [
        claimComment(1),
        claimComment(4, {
          authorLogin: 'stranger',
          createdAt: '2026-10-01T00:00:00Z',
        }),
        claimComment(5, {
          lastEditedAt: '2026-10-16T02:00:00Z',
          createdAt: '2026-10-01T00:00:00Z',
        }),
      ],
      CLAIM,
      BRANCH,
      trusted,
    ),
    ACTIVATED,
  );
  assert.equal(
    findClaimActivationTime(
      [claimComment(1)],
      'another-claim',
      BRANCH,
      trusted,
    ),
    null,
  );
});

// --- reads that throw, and the diagnostics a reason code carries -----------

test('a claim read that throws is a hold on claim-or-lock with its cause in the warnings', () => {
  const throwing: Partial<F4HeadProofGateDeps>[] = [
    {
      readTokens: () => {
        throw new Error('git rev-parse failed');
      },
    },
    {
      assertClaim: () => {
        throw new Error('spawn failed');
      },
    },
    {
      checkLock: () => {
        throw new Error('lock read failed');
      },
    },
  ];
  for (const override of throwing) {
    const h = harness(override);
    const output = expectVerdict(
      runF4HeadProofGate(APPLY, h.deps),
      'hold',
      'claim-or-lock',
      1,
    );
    assert.equal(output.warnings?.length, 1, JSON.stringify(output.warnings));
    assert.deepEqual(h.posts, []);
  }
});

test('a branch name check that throws is a hold on ref-read', () => {
  const h = harness({
    isValidRefName: () => {
      throw new Error('git failed');
    },
  });
  const output = expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'hold',
    'ref-read',
    1,
  );
  assert.match(output.warnings?.join('\n') ?? '', /branch name check failed/);
});

test('the warnings name the cause behind each unreadable-claim or failed-read reason', () => {
  const unreadable = harness({
    assertClaim: () => ({ status: 'unreadable', detail: 'printed no JSON' }),
  });
  assert.match(
    verdictOf(runF4HeadProofGate(INPUT, unreadable.deps)).output.warnings?.join(
      '\n',
    ) ?? '',
    /claim check could not be read: printed no JSON/,
  );
  const noNonce = harness({
    readTokens: () => ({ status: 'malformed', path: '/tokens' }),
  });
  assert.match(
    verdictOf(runF4HeadProofGate(INPUT, noNonce.deps)).output.warnings?.join(
      '\n',
    ) ?? '',
    /activation record is malformed/,
  );
  const prFailure = harness({
    listPullRequests: () => {
      throw new Error('gh pr list failed');
    },
  });
  assert.match(
    verdictOf(runF4HeadProofGate(INPUT, prFailure.deps)).output.warnings?.join(
      '\n',
    ) ?? '',
    /pull request lookup failed: gh pr list failed/,
  );
  const twoMerged = harness({
    listPullRequests: () => [
      { number: 1, merged: true },
      { number: 2, merged: true },
    ],
  });
  assert.match(
    verdictOf(runF4HeadProofGate(INPUT, twoMerged.deps)).output.warnings?.join(
      '\n',
    ) ?? '',
    /2 merged pull requests/,
  );
  const rejected = harness({
    postComment: () => {
      throw statusError(422);
    },
  });
  assert.match(
    verdictOf(runF4HeadProofGate(APPLY, rejected.deps)).output.warnings?.join(
      '\n',
    ) ?? '',
    /post was rejected: .*HTTP 422/,
  );
  const healthy = harness();
  assert.equal(
    verdictOf(runF4HeadProofGate(INPUT, healthy.deps)).output.warnings,
    undefined,
  );
});

// --- runF4HeadProofCommand: the CLI wrapper around the gate ----------------

const outputSchema = loadJson('schemas/post-idd-marker.schema.json');

function runCommand(
  flags: string[],
  deps: F4HeadProofGateDeps,
): {
  result: ReturnType<typeof runF4HeadProofCommand>;
  out: string;
  err: string;
} {
  const args = parseArgs([
    '--type',
    'f4-head-proof',
    '--target',
    'issue',
    String(ISSUE),
    '--owner',
    'example-owner',
    '--repo',
    'example-repo',
    '--claim-id',
    CLAIM,
    '--agent-id',
    AGENT,
    '--worktree',
    WORKTREE,
    ...flags,
  ]);
  let out = '';
  let err = '';
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = runF4HeadProofCommand(args, ISSUE, () => deps);
    return { result, out, err };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

test('the command prints the dry-run envelope for a post verdict and exits 0', () => {
  const h = harness();
  const { result, out, err } = runCommand([], h.deps);
  assert.equal(result, 0);
  assert.equal(err, '');
  const envelope = JSON.parse(out);
  assert.equal(envelope.verdict, 'post');
  assert.equal(envelope.reason, null);
  assert.equal(envelope.body, EXPECTED_BODY);
  assert.deepEqual(validate(envelope, outputSchema), []);
  assert.deepEqual(h.posts, []);
});

test('the command posts under --apply and prints the confirmed envelope', () => {
  const h = harness();
  const { result, out } = runCommand(['--apply'], h.deps);
  assert.equal(result, 0);
  const envelope = JSON.parse(out);
  assert.equal(envelope.mode, 'apply');
  assert.equal(envelope.verdict, 'proceed');
  assert.equal(envelope.reason, 'posted-confirmed');
  assert.equal(envelope.commentId, 9001);
  assert.deepEqual(validate(envelope, outputSchema), []);
  assert.deepEqual(h.posts, [EXPECTED_BODY]);
});

test('the command exits 1 with the JSON and a one-line reason for a hold', () => {
  const h = harness({
    assertClaim: () => ({ status: 'unreadable', detail: 'x' }),
  });
  const { result, out, err } = runCommand(['--apply'], h.deps);
  assert.deepEqual(
    { ...(result as object), message: undefined },
    { exitCode: 1, kind: 'gate', message: undefined },
  );
  const envelope = JSON.parse(out);
  assert.equal(envelope.verdict, 'hold');
  assert.equal(envelope.reason, 'claim-or-lock');
  assert.deepEqual(validate(envelope, outputSchema), []);
  assert.match(err, /^f4-head-proof: hold \(claim-or-lock\)\. /);
  assert.deepEqual(h.posts, []);
});

test('the command exits 1 for a stop', () => {
  const h = harness({ assertClaim: () => ({ status: 'not-owned' }) });
  const { result, out } = runCommand([], h.deps);
  assert.equal((result as { exitCode: number }).exitCode, 1);
  assert.equal(JSON.parse(out).verdict, 'stop');
});

test('the command exits non-zero with nothing printed or posted when the renderer rejects a value', () => {
  // The agent ID is the one rendered value that comes from a flag.
  const h = harness();
  const bad = runCommand(['--agent-id', 'bad agent', '--apply'], h.deps);
  assert.equal((bad.result as { exitCode: number }).exitCode, 1);
  assert.equal(bad.out, '');
  assert.match(bad.err, /agentId must be non-empty and contain no whitespace/);
  assert.deepEqual(h.posts, []);
});

test('the command refuses an unregistered worktree with a usage error', () => {
  const h = harness({ isRegisteredWorktree: () => false });
  const { result, out, err } = runCommand([], h.deps);
  assert.equal((result as { kind: string }).kind, 'usage');
  assert.equal(out, '');
  assert.match(
    err,
    /not a worktree that git worktree list --porcelain registers/,
  );
});

test('the command refuses a derived proof flag and a flag it does not take', () => {
  const h = harness();
  const derived = runCommand(['--merge', MERGE], h.deps);
  assert.equal((derived.result as { kind: string }).kind, 'usage');
  assert.match(
    derived.err,
    /takes only --target, --claim-id, --agent-id and --worktree/,
  );
  assert.deepEqual(h.posts, []);
});

test('the command refuses --advisory-bot-logins', () => {
  const h = harness();
  const { result, err } = runCommand(['--advisory-bot-logins', 'a'], h.deps);
  assert.equal((result as { kind: string }).kind, 'usage');
  assert.match(err, /does not take --advisory-bot-logins/);
});

test('a bad agent or claim ID fails before any read, with the renderer error', () => {
  for (const bad of [
    { ...INPUT, agentId: 'bad agent' },
    { ...INPUT, claimId: 'bad claim' },
    { ...INPUT, claimId: 'a-->b' },
    { ...INPUT, agentId: '' },
  ]) {
    const h = harness();
    assert.throws(() => runF4HeadProofGate(bad, h.deps), /f4-head-proof: /);
    assert.deepEqual(h.calls, []);
  }
});

test('a stop on claim-or-lock tells the caller to end quietly, not to rerun', () => {
  const h = harness({ assertClaim: () => ({ status: 'not-owned' }) });
  const output = expectVerdict(
    runF4HeadProofGate(APPLY, h.deps),
    'stop',
    'claim-or-lock',
    1,
  );
  assert.match(output.nextAction ?? '', /do not continue F4/);
  assert.doesNotMatch(output.nextAction ?? '', /rerun/);
  const held = harness({
    assertClaim: () => ({ status: 'unreadable', detail: 'x' }),
  });
  assert.match(
    verdictOf(runF4HeadProofGate(APPLY, held.deps)).output.nextAction ?? '',
    /then rerun/,
  );
});

test('a warning is the first line of the error message, cut to 300 characters', () => {
  const h = harness({
    listPullRequests: () => {
      throw new Error(`${'x'.repeat(1000)}\nsecond line`);
    },
  });
  const warnings = verdictOf(runF4HeadProofGate(INPUT, h.deps)).output.warnings;
  assert.equal(warnings?.length, 1);
  const warning = warnings?.[0] ?? '';
  assert.ok(warning.includes('x'.repeat(300)));
  assert.ok(!warning.includes('x'.repeat(301)));
  assert.ok(!warning.includes('second line'));
});
