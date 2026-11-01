import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type DraftTransitionRequest,
  evaluatePullRequestDraftTransition,
  type GhResult,
} from '../src/scripts/pull-request-draft-state.mts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REPO = 'kurone-kito/idd-skill';

interface PullRequestFixture {
  nodeId?: string;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  sha?: string;
  base?: string;
}

function pr(fixture: PullRequestFixture = {}) {
  return {
    node_id: fixture.nodeId ?? 'PR_kwDOExample',
    state: fixture.state ?? 'open',
    merged: fixture.merged ?? false,
    draft: fixture.draft ?? false,
    head: { sha: fixture.sha ?? HEAD },
    base: { repo: { full_name: fixture.base ?? REPO } },
  };
}

function ok(body: unknown): GhResult {
  return { status: 0, stdout: JSON.stringify(body), stderr: '' };
}

const MUTATION_OK: GhResult = { status: 0, stdout: '{}', stderr: '' };
const MUTATION_FAIL: GhResult = {
  status: 1,
  stdout: '',
  stderr: 'graphql: forbidden',
};

interface Script {
  /** Pull request reads, consumed in call order. An `Error` makes that call throw. */
  reads: Array<GhResult | Error>;
  /** The GraphQL mutation response. An `Error` makes it throw. */
  mutation?: GhResult | Error;
}

function fakeGh(script: Script) {
  const calls: string[][] = [];
  const reads = [...script.reads];
  const gh = (args: readonly string[]): GhResult => {
    calls.push([...args]);
    if (args.includes('graphql')) {
      const response = script.mutation ?? MUTATION_OK;
      if (response instanceof Error) {
        throw response;
      }
      return response;
    }
    const next = reads.shift();
    if (next === undefined) {
      throw new Error('unexpected extra pull request read');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return {
    deps: { gh },
    mutationCalls: () => calls.filter((args) => args.includes('graphql')),
  };
}

function request(
  overrides: Partial<DraftTransitionRequest> = {},
): DraftTransitionRequest {
  return {
    owner: 'kurone-kito',
    repo: 'idd-skill',
    number: 4934,
    target: 'draft',
    expectedHeadSha: HEAD,
    apply: true,
    ...overrides,
  };
}

test('dry run reports the observed state and sends no transition request', () => {
  const gh = fakeGh({ reads: [ok(pr({ draft: false }))] });
  const report = evaluatePullRequestDraftTransition(
    request({ apply: false }),
    gh.deps,
  );
  assert.equal(report.verdict, 'dry-run');
  assert.equal(report.mutationSent, false);
  assert.equal(report.observed?.isDraft, false);
  assert.equal(report.observed?.headSha, HEAD);
  assert.equal(report.target, 'draft');
  assert.equal(report.expectedHeadSha, HEAD);
  assert.equal(gh.mutationCalls().length, 0);
});

test('applied draft transition is confirmed by a fresh read', () => {
  const gh = fakeGh({
    reads: [
      ok(pr({ draft: false })),
      ok(pr({ draft: false })),
      ok(pr({ draft: true })),
    ],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'transitioned');
  assert.equal(report.mutationSent, true);
  assert.equal(report.observed?.isDraft, true);
  const mutations = gh.mutationCalls();
  assert.equal(mutations.length, 1);
  assert.ok(
    mutations[0]?.some((arg) => arg.includes('convertPullRequestToDraft')),
  );
});

test('applied ready transition uses the ready-for-review mutation', () => {
  const gh = fakeGh({
    reads: [
      ok(pr({ draft: true })),
      ok(pr({ draft: true })),
      ok(pr({ draft: false })),
    ],
  });
  const report = evaluatePullRequestDraftTransition(
    request({ target: 'ready' }),
    gh.deps,
  );
  assert.equal(report.verdict, 'transitioned');
  assert.equal(report.observed?.isDraft, false);
  const mutations = gh.mutationCalls();
  assert.equal(mutations.length, 1);
  assert.ok(
    mutations[0]?.some((arg) => arg.includes('markPullRequestReadyForReview')),
  );
});

test('a dry run on a state that differs from the target names the change', () => {
  const gh = fakeGh({ reads: [ok(pr({ draft: true }))] });
  const report = evaluatePullRequestDraftTransition(
    request({ apply: false, target: 'ready' }),
    gh.deps,
  );
  assert.equal(report.verdict, 'dry-run');
  assert.match(report.detail, /would change draft state to ready/);
  assert.equal(gh.mutationCalls().length, 0);
});

test('an applied request already in the target state sends no mutation', () => {
  const gh = fakeGh({ reads: [ok(pr({ draft: true }))] });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'already-in-target-state');
  assert.equal(report.mutationSent, false);
  assert.equal(gh.mutationCalls().length, 0);
});

test('a closed pull request is refused before any transition request', () => {
  const gh = fakeGh({ reads: [ok(pr({ state: 'closed' }))] });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'refused');
  assert.equal(report.refusal, 'closed');
  assert.equal(report.mutationSent, false);
  assert.equal(gh.mutationCalls().length, 0);
});

test('a merged pull request is refused as merged', () => {
  const gh = fakeGh({
    reads: [ok(pr({ state: 'closed', merged: true }))],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.refusal, 'merged');
  assert.equal(gh.mutationCalls().length, 0);
});

test('an inaccessible pull request is refused', () => {
  const gh = fakeGh({
    reads: [{ status: 1, stdout: '', stderr: 'HTTP 404' }],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.refusal, 'inaccessible');
  assert.equal(report.observed, null);
  assert.equal(gh.mutationCalls().length, 0);
});

test('a pull request from another base repository is refused', () => {
  const gh = fakeGh({
    reads: [ok(pr({ base: 'someone-else/idd-skill' }))],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.refusal, 'wrong-base-repository');
  assert.equal(gh.mutationCalls().length, 0);
});

test('a head that differs from the expected SHA is refused on the first read', () => {
  const gh = fakeGh({ reads: [ok(pr({ sha: OTHER }))] });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.refusal, 'changed-head');
  assert.equal(gh.mutationCalls().length, 0);
});

test('an unknown target is refused before any read', () => {
  const gh = fakeGh({ reads: [] });
  const report = evaluatePullRequestDraftTransition(
    request({ target: 'merge' as unknown as 'draft' }),
    gh.deps,
  );
  assert.equal(report.refusal, 'invalid-target');
  assert.equal(report.mutationSent, false);
  assert.equal(gh.mutationCalls().length, 0);
});

test('a short expected head SHA is refused before any read', () => {
  const gh = fakeGh({ reads: [] });
  const report = evaluatePullRequestDraftTransition(
    request({ expectedHeadSha: 'abc123' }),
    gh.deps,
  );
  assert.equal(report.refusal, 'invalid-head-sha');
  assert.equal(gh.mutationCalls().length, 0);
});

test('a malformed pull request read is refused as read-failed', () => {
  const gh = fakeGh({
    reads: [{ status: 0, stdout: 'not json', stderr: '' }],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.refusal, 'read-failed');
  assert.equal(gh.mutationCalls().length, 0);
});

test('a head race between the first read and the pre-mutation read is refused', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr({ sha: OTHER }))],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'refused');
  assert.equal(report.refusal, 'changed-head');
  assert.equal(report.mutationSent, false);
  assert.equal(gh.mutationCalls().length, 0);
});

test('a state that is still wrong after the mutation is unverified', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr()), ok(pr({ draft: false }))],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'unverified');
  assert.equal(report.mutationSent, true);
  assert.equal(report.observed?.isDraft, false);
});

test('a post-change read that throws is unverified with no observed state', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr()), new Error('socket hang up')],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'unverified');
  assert.equal(report.observed, null);
  assert.equal(report.mutationSent, true);
});

test('a post-change read that shows the pull request closed is unverified', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr()), ok(pr({ state: 'closed', draft: true }))],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'unverified');
  assert.equal(report.refusal, 'closed');
});

test('a failed mutation with an unchanged state is refused as transition-failed', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr()), ok(pr())],
    mutation: MUTATION_FAIL,
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'refused');
  assert.equal(report.refusal, 'transition-failed');
  assert.equal(report.mutationSent, true);
});

test('a mutation that throws but leaves the target state is unverified', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr()), ok(pr({ draft: true }))],
    mutation: new Error('connection reset'),
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'unverified');
  assert.equal(report.observed?.isDraft, true);
  assert.equal(report.mutationSent, true);
});

test('a mutation that throws and a failing verification read is unverified', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr()), new Error('timeout')],
    mutation: new Error('connection reset'),
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'unverified');
  assert.equal(report.observed, null);
});

test('a zero, negative, or non-integer pull request number is refused before any read', () => {
  for (const number of [0, -1, 1.5, Number.NaN]) {
    const gh = fakeGh({ reads: [] });
    const report = evaluatePullRequestDraftTransition(
      request({ number }),
      gh.deps,
    );
    assert.equal(report.refusal, 'invalid-number', `number ${number}`);
    assert.equal(report.mutationSent, false);
    assert.equal(gh.mutationCalls().length, 0);
  }
});

test('a pre-mutation read that fails is refused with no mutation', () => {
  const gh = fakeGh({
    reads: [ok(pr()), { status: 1, stdout: '', stderr: 'HTTP 503' }],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'refused');
  assert.equal(report.refusal, 'inaccessible');
  assert.equal(report.mutationSent, false);
  assert.equal(gh.mutationCalls().length, 0);
});

test('a pre-mutation read that shows the pull request closed is refused with no mutation', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr({ state: 'closed' }))],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.refusal, 'closed');
  assert.equal(report.mutationSent, false);
  assert.equal(gh.mutationCalls().length, 0);
});

test('a pre-mutation read that shows the pull request merged is refused with no mutation', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr({ state: 'closed', merged: true }))],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.refusal, 'merged');
  assert.equal(report.mutationSent, false);
  assert.equal(gh.mutationCalls().length, 0);
});

test('a failed mutation followed by a merged post-change read is unverified, not refused', () => {
  const gh = fakeGh({
    reads: [ok(pr()), ok(pr()), ok(pr({ state: 'closed', merged: true }))],
    mutation: MUTATION_FAIL,
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'unverified');
  assert.equal(report.refusal, 'merged');
  assert.equal(report.mutationSent, true);
});

test('a pre-mutation read that already shows the target state sends no mutation', () => {
  const gh = fakeGh({
    reads: [ok(pr({ draft: false })), ok(pr({ draft: true }))],
  });
  const report = evaluatePullRequestDraftTransition(request(), gh.deps);
  assert.equal(report.verdict, 'already-in-target-state');
  assert.equal(report.mutationSent, false);
  assert.equal(gh.mutationCalls().length, 0);
});
