import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { retryTransientGhFailure } from '../src/scripts/advisory-convergence.mts';
import {
  type ApplyDispositionPlanDeps,
  applyDispositionPlan,
  type DispositionPlan,
} from '../src/scripts/disposition-non-review-notices.mts';
import { setGithubApiLoadControlForTests } from '../src/scripts/gh-exec.mts';
import {
  admitRequestSync,
  loadControlScopeName,
} from '../src/scripts/github-api-load-control.mts';
import {
  createLoadControlRefusal,
  findLoadControlRefusal,
  isNotDispatchedRefusal,
  preserveLoadControlRefusal,
} from '../src/scripts/github-api-refusal.mts';
import {
  buildHelperErrorEnvelope,
  classifyHelperError,
} from '../src/scripts/helper-cli-runner.mts';
import {
  postRepairEvidenceWithReconciliation,
  reconcileFailedRetirement,
} from '../src/scripts/live-status-digest.mts';
import {
  createGithubProviderAdapter,
  type GithubProviderAdapterDeps,
} from '../src/scripts/provider-adapter-github.mts';
import { stubExecutable } from './test-utils.mts';

const cleanups: (() => void)[] = [];

afterEach(() => {
  setGithubApiLoadControlForTests(null);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A refusal as the transport throws it, tagged like any gh command error. */
function refusal(
  reason: 'busy' | 'cooldown' = 'busy',
  retryAt?: string,
): Error {
  const error = createLoadControlRefusal({
    outcome: 'not-dispatched',
    reason,
    ...(retryAt ? { retryAt, retryAtSource: 'server' as const } : {}),
  });
  Object.defineProperty(error, 'ghCommand', { value: true, enumerable: false });
  return error;
}

function fakeDeps(
  overrides: Partial<GithubProviderAdapterDeps>,
): GithubProviderAdapterDeps {
  return {
    ghText: () => {
      throw new Error('ghText not stubbed for this test');
    },
    ghApiJson: () => {
      throw new Error('ghApiJson not stubbed for this test');
    },
    resolveViewerLogin: () => {
      throw new Error('resolveViewerLogin not stubbed for this test');
    },
    ghTextAsync: () => {
      throw new Error('ghTextAsync not stubbed for this test');
    },
    sleepSync: () => {
      throw new Error('a refusal must not sleep before a retry');
    },
    ...overrides,
  } as GithubProviderAdapterDeps;
}

const POSTED = JSON.stringify({
  id: 42,
  html_url: 'https://example/42',
  body: 'marker body',
});

// -- postWorkItemComment ------------------------------------------------------------------

test('a refusal on the first comment POST sends nothing: no duplicate re-read and no retry', () => {
  let posts = 0;
  let rereads = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        posts += 1;
        throw refusal('cooldown', '2026-09-30T10:00:00.000Z');
      },
      ghApiJson: () => {
        rereads += 1;
        return [];
      },
    }),
  );
  assert.throws(
    () => port.postWorkItemComment(9, 'marker body'),
    (error) => {
      assert.equal(isNotDispatchedRefusal(error), true);
      assert.equal(
        findLoadControlRefusal(error)?.retryAt,
        '2026-09-30T10:00:00.000Z',
      );
      return true;
    },
  );
  assert.equal(posts, 1, 'no second POST');
  assert.equal(rereads, 0, 'not an ambiguous write: nothing to look for');
});

test('a refusal after an earlier ambiguous failure stops posting and runs only the final duplicate check', () => {
  let posts = 0;
  let rereads = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        posts += 1;
        if (posts === 1) throw new Error('transient: no status');
        throw refusal();
      },
      ghApiJson: () => {
        rereads += 1;
        return [];
      },
      sleepSync: () => {},
    }),
  );
  assert.throws(
    () => port.postWorkItemComment(9, 'marker body'),
    (error) => {
      // The first attempt may have landed, so the error must not claim that
      // nothing was sent.
      assert.equal(isNotDispatchedRefusal(error), false);
      assert.match((error as Error).message, /transient: no status/);
      return true;
    },
  );
  assert.equal(posts, 2, 'the refused POST is not retried');
  assert.equal(rereads, 2, 'the pre-retry check plus the final check');
});

test('a refusal after an earlier failure still returns the comment when the final check finds it', () => {
  let posts = 0;
  let rereads = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        posts += 1;
        if (posts === 1) throw new Error('transient: no status');
        throw refusal();
      },
      ghApiJson: () => {
        rereads += 1;
        // Not there before the retry, there at the final check: the first
        // attempt landed after all.
        return rereads === 1
          ? []
          : [{ id: 77, body: 'marker body', html_url: 'https://example/77' }];
      },
      sleepSync: () => {},
    }),
  );
  assert.deepEqual(port.postWorkItemComment(9, 'marker body'), {
    id: 77,
    htmlUrl: 'https://example/77',
  });
});

test('a real failure keeps the existing recovery: re-read, back off, and retry', () => {
  let posts = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        posts += 1;
        if (posts === 1) throw new Error('transient: (HTTP 502)');
        return POSTED;
      },
      ghApiJson: () => [],
      sleepSync: () => {},
    }),
  );
  assert.deepEqual(port.postWorkItemComment(9, 'marker body'), {
    id: 42,
    htmlUrl: 'https://example/42',
  });
  assert.equal(posts, 2);
});

// -- traversal and comment reads --------------------------------------------------------------

test('a refused traversal issue read is thrown as is and not retried', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        throw refusal();
      },
    }),
  );
  await assert.rejects(
    port.getWorkItemForTraversalAsync?.(5) as Promise<unknown>,
    (error) => isNotDispatchedRefusal(error),
  );
  assert.equal(calls, 1);
});

test('a refused sub-issue GraphQL read keeps its refusal tag and is not retried', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        throw refusal('cooldown', '2026-09-30T10:00:00.000Z');
      },
    }),
  );
  await assert.rejects(
    port.listWorkItemSubIssueNodesAsync?.(5) as Promise<unknown>,
    (error) => {
      assert.equal(
        findLoadControlRefusal(error)?.retryAt,
        '2026-09-30T10:00:00.000Z',
      );
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('a refused comment page read is not rebuilt into a retryable transport error', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        calls += 1;
        throw refusal();
      },
    }),
  );
  await assert.rejects(
    port.listWorkItemCommentsWithRetryAsync?.(5, {
      includeEditState: true,
    }) as Promise<unknown>,
    (error) => {
      assert.equal(isNotDispatchedRefusal(error), true);
      assert.equal((error as Error).name, 'GithubApiLoadControlRefusal');
      return true;
    },
  );
  assert.equal(calls, 1, 'no partial or empty result and no retry');
});

// -- disposition apply loop ----------------------------------------------------------------------

function onePlannedDisposition(): DispositionPlan {
  return {
    headSha: 'abc1234',
    planned: [
      {
        noticeId: 101,
        botLogin: 'coderabbitai[bot]',
        reason: 'review limit reached / rate limited',
        body: 'disposition body issuecomment-101',
      },
    ],
    skipped: [],
  };
}

test('a refused disposition post is not recovered, retried, or double-posted', () => {
  let posts = 0;
  let recoveries = 0;
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => {
      posts += 1;
      throw refusal();
    },
    recoverPostedDisposition: () => {
      recoveries += 1;
      return null;
    },
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(onePlannedDisposition(), deps);
  assert.equal(posts, 1);
  assert.equal(recoveries, 0);
  assert.deepEqual(result.applied, []);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /not dispatched/);
  assert.equal(isNotDispatchedRefusal(result.postFailure), true);
});

test('an ordinary disposition failure still recovers and retries once', () => {
  let posts = 0;
  let recoveries = 0;
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => {
      posts += 1;
      throw new Error('gh: HTTP 503');
    },
    recoverPostedDisposition: () => {
      recoveries += 1;
      return null;
    },
    knownViewerCommentIds: new Set(),
  };
  applyDispositionPlan(onePlannedDisposition(), deps);
  assert.equal(posts, 2);
  assert.equal(recoveries, 2);
});

test('a refused recovery read after a failed create reports the create and stops without a second POST', () => {
  let posts = 0;
  let recoveries = 0;
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => true,
    postDisposition: () => {
      posts += 1;
      throw new Error('gh: Server Error (HTTP 502)');
    },
    recoverPostedDisposition: () => {
      recoveries += 1;
      throw refusal('cooldown', '2026-09-30T10:00:00.000Z');
    },
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(onePlannedDisposition(), deps);
  assert.equal(posts, 1, 'a second POST could double-post');
  assert.equal(recoveries, 1);
  assert.deepEqual(result.applied, []);
  assert.match(result.failed[0].error, /HTTP 502/);
  assert.match(result.failed[0].error, /recovery read not dispatched/);
  // The failure reported is the create's, which may have landed.
  assert.equal(isNotDispatchedRefusal(result.postFailure), false);
  assert.match((result.postFailure as Error).message, /HTTP 502/);
});

test('a refused claim revalidation keeps the report of what was already posted', () => {
  const plan: DispositionPlan = {
    headSha: 'abc1234',
    planned: [101, 102].map((noticeId) => ({
      noticeId,
      botLogin: 'coderabbitai[bot]',
      reason: 'review limit reached / rate limited',
      body: `disposition body issuecomment-${noticeId}`,
    })),
    skipped: [],
  };
  let revalidations = 0;
  const posted: number[] = [];
  const deps: ApplyDispositionPlanDeps = {
    revalidateClaim: () => {
      revalidations += 1;
      if (revalidations === 2)
        throw refusal('cooldown', '2026-09-30T10:00:00.000Z');
      return true;
    },
    postDisposition: (body) => {
      const noticeId = Number(/issuecomment-(\d+)/.exec(body)?.[1]);
      posted.push(noticeId);
      return { id: 9000 + noticeId };
    },
    recoverPostedDisposition: () => null,
    knownViewerCommentIds: new Set(),
  };
  const result = applyDispositionPlan(plan, deps);
  assert.deepEqual(
    posted,
    [101],
    'nothing is posted under an unverified claim',
  );
  assert.deepEqual(result.applied, [{ noticeId: 101, commentId: 9101 }]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].noticeId, 102);
  assert.match(result.failed[0].error, /claim revalidation not dispatched/);
  assert.equal(result.claimLost, false);
  assert.equal(isNotDispatchedRefusal(result.postFailure), true);
});

test('a bounded retry of gh reads never retries a refusal', () => {
  let calls = 0;
  assert.throws(
    () =>
      retryTransientGhFailure(
        () => {
          calls += 1;
          throw refusal();
        },
        { sleep: () => {} },
      ),
    (error) => isNotDispatchedRefusal(error),
  );
  assert.equal(calls, 1);
  // A transient failure with no status is still retried, as before.
  let transient = 0;
  assert.throws(() =>
    retryTransientGhFailure(
      () => {
        transient += 1;
        throw new Error('socket hang up');
      },
      { sleep: () => {} },
    ),
  );
  assert.equal(transient, 3);
});

// -- live-status digest repair ---------------------------------------------------------------------

const RECONCILE_STUB = String.raw`
const fs = require('node:fs');
fs.appendFileSync(process.env.IDD_STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
process.exit(1);
`;

test('a refused retirement PATCH reconciles nothing and spawns no gh, an ordinary failure still does', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-refusal-digest-'));
  const log = join(root, 'calls.log');
  const restore = stubExecutable('gh', RECONCILE_STUB);
  const saved = process.env.IDD_STUB_LOG;
  process.env.IDD_STUB_LOG = log;
  cleanups.push(() => {
    restore();
    if (saved === undefined) delete process.env.IDD_STUB_LOG;
    else process.env.IDD_STUB_LOG = saved;
    rmSync(root, { recursive: true, force: true });
  });
  const retirement = reconcileFailedRetirement(
    refusal(),
    'o',
    'r',
    'issue',
    3586,
    '123',
    'body',
  );
  assert.equal(retirement.retired, false);
  assert.equal(retirement.postflight, null);
  assert.match(retirement.detail, /not dispatched/);
  assert.equal(existsSync(log), false, 'no reconciliation read was made');

  // An ordinary failure may have landed and is still reconciled.
  const ordinary = reconcileFailedRetirement(
    new Error('gh: HTTP 502'),
    'o',
    'r',
    'issue',
    3586,
    '123',
    'body',
  );
  assert.match(ordinary.detail, /ambiguous mutation reconciliation/);
  assert.equal(
    existsSync(log),
    true,
    'the reconciliation reads were attempted',
  );
});

test('the evidence write, refused by load control, is rethrown without a reconciliation read', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-refusal-digest-'));
  const log = join(root, 'calls.log');
  const restore = stubExecutable('gh', RECONCILE_STUB);
  const saved = process.env.IDD_STUB_LOG;
  process.env.IDD_STUB_LOG = log;
  cleanups.push(() => {
    restore();
    if (saved === undefined) delete process.env.IDD_STUB_LOG;
    else process.env.IDD_STUB_LOG = saved;
    rmSync(root, { recursive: true, force: true });
  });
  const state = join(root, 'state');
  const identity = { host: 'github.com', credentialMaterial: 'credential-a' };
  const runtime = {
    directory: state,
    pidNamespace: 'ns',
    isPidAlive: () => true,
    processIdentity: () => ({}),
  };
  const policy = { enabled: true, maxConcurrent: 1, maxWaitMs: 1_000 };
  // A throttle is already recorded, so a write is refused at the gate.
  const gate = admitRequestSync(
    identity,
    policy,
    { classification: 'read', resource: 'core' },
    runtime,
  );
  assert.ok(gate);
  gate.recordFailure({
    stderr: 'gh: You have exceeded a secondary rate limit. (HTTP 403)',
    stdout: '',
  });
  gate.release();
  assert.ok(existsSync(join(state, loadControlScopeName(identity))));
  setGithubApiLoadControlForTests({ policy, identity, runtime });

  assert.throws(
    () =>
      postRepairEvidenceWithReconciliation(
        'o',
        'r',
        3586,
        'evidence',
        'maintainer',
        new Set(),
      ),
    (error) => {
      assert.equal(isNotDispatchedRefusal(error), true);
      return true;
    },
  );
  assert.equal(
    existsSync(log),
    false,
    'neither the refused write nor a reconciliation read spawned gh',
  );
});

const FAILING_WRITE_STUB = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.IDD_STUB_LOG, JSON.stringify(args) + '\n');
if (args.includes('POST')) {
  process.stderr.write('gh: You have exceeded a secondary rate limit. (HTTP 403)\n');
}
process.exit(1);
`;

test('a write that fails and whose reconciliation read is refused is not reported as nothing sent', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-refusal-composite-'));
  const log = join(root, 'calls.log');
  const restore = stubExecutable('gh', FAILING_WRITE_STUB);
  const saved = process.env.IDD_STUB_LOG;
  process.env.IDD_STUB_LOG = log;
  cleanups.push(() => {
    restore();
    if (saved === undefined) delete process.env.IDD_STUB_LOG;
    else process.env.IDD_STUB_LOG = saved;
    rmSync(root, { recursive: true, force: true });
  });
  setGithubApiLoadControlForTests({
    policy: { enabled: true, maxConcurrent: 1, maxWaitMs: 1_000 },
    identity: { host: 'github.com', credentialMaterial: 'credential-a' },
    runtime: {
      directory: join(root, 'state'),
      pidNamespace: 'ns',
      isPidAlive: () => true,
      processIdentity: () => ({}),
    },
  });
  assert.throws(
    () =>
      postRepairEvidenceWithReconciliation(
        'o',
        'r',
        3586,
        'evidence',
        'maintainer',
        new Set(),
      ),
    (error) => {
      // The POST was dispatched and failed; the throttle it met made the
      // reconciliation read wait out a cooldown longer than the deadline.
      assert.match((error as Error).message, /evidence reconciliation failed/);
      assert.equal(isNotDispatchedRefusal(error), true, 'the read was refused');
      const classified = classifyHelperError(error);
      assert.equal(classified.kind, 'transport');
      assert.equal(
        classified.notDispatched,
        undefined,
        'the write may have landed, so nothing-sent must not be claimed',
      );
      return true;
    },
  );
  const posts = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.includes('POST'));
  assert.equal(posts.length, 1, 'the write was sent exactly once');
});

// -- helper envelope ------------------------------------------------------------------------------------

test('a refusal is classified as transport with notDispatched and retryAt in the envelope', () => {
  const error = refusal('cooldown', '2026-09-30T10:00:00.000Z');
  const classified = classifyHelperError(error);
  assert.deepEqual(classified, {
    kind: 'transport',
    message: error.message,
    httpStatus: null,
    notDispatched: true,
    retryAt: '2026-09-30T10:00:00.000Z',
  });
  const envelope = buildHelperErrorEnvelope('helper', 1, classified);
  assert.equal(envelope.iddHelperError.notDispatched, true);
  assert.equal(envelope.iddHelperError.retryAt, '2026-09-30T10:00:00.000Z');
  // A refusal with no known end still says nothing was sent.
  const busy = classifyHelperError(refusal('busy'));
  assert.equal(busy.notDispatched, true);
  assert.equal('retryAt' in busy, false);
});

test('a refusal survives a wrapper that copies its tags, and ordinary failures keep the old envelope', () => {
  const rebuilt = preserveLoadControlRefusal(
    new Error('provider failed'),
    refusal('cooldown', '2026-09-30T10:00:00.000Z'),
  );
  const classified = classifyHelperError(rebuilt);
  assert.equal(classified.kind, 'transport');
  assert.equal(classified.notDispatched, true);
  assert.deepEqual(Object.keys(rebuilt), []);

  const ordinary = Object.assign(new Error('gh: HTTP 502'), {
    stderr: 'gh: Server Error (HTTP 502)',
  });
  Object.defineProperty(ordinary, 'ghCommand', { value: true });
  const plain = classifyHelperError(ordinary);
  assert.deepEqual(plain, {
    kind: 'transport',
    message: plain.message,
    httpStatus: 502,
  });
  assert.equal(
    JSON.stringify(buildHelperErrorEnvelope('helper', 1, plain)).includes(
      'notDispatched',
    ),
    false,
    'the envelope of an ordinary failure has no new field',
  );
});

test('an error that only wraps a refused read is not reported as nothing sent', () => {
  // A write failed, and the read that would have reconciled it was refused.
  const composite = new Error(
    'evidence write failed; evidence reconciliation failed: not dispatched',
    { cause: refusal('cooldown', '2026-09-30T10:00:00.000Z') },
  );
  const classified = classifyHelperError(composite);
  assert.equal(classified.kind, 'transport');
  assert.equal(classified.notDispatched, undefined);
  assert.equal(classified.retryAt, undefined);
  // The chain walk used for retry decisions still finds the refusal.
  assert.equal(isNotDispatchedRefusal(composite), true);
});

test('a composite error keeps its own message and never gains a refusal through a wrapper', () => {
  const composite = new Error(
    'evidence write failed (HTTP 403); evidence reconciliation failed',
    { cause: refusal('cooldown', '2026-09-30T10:00:00.000Z') },
  );
  assert.equal(classifyHelperError(composite).message, composite.message);
  const rebuilt = preserveLoadControlRefusal(new Error('rebuilt'), composite);
  assert.equal(isNotDispatchedRefusal(rebuilt), false);
  assert.equal(classifyHelperError(rebuilt).notDispatched, undefined);
});

test('a refused issue lookup through the provider wrapper still reports notDispatched and retryAt', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghApiJson: () => {
        throw refusal('cooldown', '2026-09-30T10:00:00.000Z');
      },
    }),
  );
  assert.throws(
    () => port.getWorkItem(5),
    (error) => {
      const classified = classifyHelperError(error);
      assert.equal(classified.kind, 'transport');
      assert.equal(classified.notDispatched, true);
      assert.equal(classified.retryAt, '2026-09-30T10:00:00.000Z');
      return true;
    },
  );
});

test('the refusal message matches no HTTP status or timeout classifier', () => {
  const error = refusal('cooldown', '2026-09-30T10:00:00.000Z');
  assert.equal(classifyHelperError(error).httpStatus, null);
  assert.equal((error as { status?: unknown }).status, undefined);
  assert.equal((error as { code?: unknown }).code, undefined);
  assert.equal((error as { killed?: unknown }).killed, undefined);
  assert.equal((error as { stderr?: unknown }).stderr, undefined);
});
