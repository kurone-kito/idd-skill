import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';

// listOpenWorkItems (Copilot review, #2400): provider-port.mts's doc comment
// on this method pins its state field to REST's raw lowercase form
// ('open'/'closed'), deliberately unlike getWorkItem's uppercased 'OPEN' --
// the fake adapter's implementation filtered on the wrong casing, so any
// fixture written per the documented contract ('open') silently returned no
// items instead of the caller's expected match.
test("listOpenWorkItems filters on the port's documented lowercase 'open' state", () => {
  const port = createFakeProviderAdapter({
    workItems: {
      1: { number: 1, title: 'open issue', body: '', state: 'open' },
      2: { number: 2, title: 'closed issue', body: '', state: 'closed' },
    },
  });
  const result = port.listOpenWorkItems();
  assert.deepEqual(
    result.map((item) => item.number),
    [1],
  );
});

test('listOpenWorkItems does not match an uppercase OPEN fixture (regression guard)', () => {
  const port = createFakeProviderAdapter({
    workItems: {
      1: { number: 1, title: 'wrong casing', body: '', state: 'OPEN' },
    },
  });
  assert.deepEqual(port.listOpenWorkItems(), []);
});

// getWorkItem (Copilot review, #2400): fixture.workItems stores REST's raw
// lowercase casing as its one canonical form (per the two tests above), but
// getWorkItem's own documented contract uppercases -- the fake adapter
// previously returned the fixture unchanged, so a correctly lowercase-
// written fixture read through getWorkItem would return the wrong casing
// relative to the real adapter's behavior.
test("getWorkItem uppercases the port's documented lowercase fixture state on read", () => {
  const port = createFakeProviderAdapter({
    workItems: {
      1: { number: 1, title: 'open issue', body: '', state: 'open' },
    },
  });
  assert.equal(port.getWorkItem(1)?.state, 'OPEN');
});

test('getWorkItem returns null for a number absent from the fixture', () => {
  const port = createFakeProviderAdapter({ workItems: {} });
  assert.equal(port.getWorkItem(1), null);
});

// closeWorkItem (Copilot review, #2400): mutated the shared fixture's state
// to uppercase 'CLOSED', drifting from fixture.workItems's one canonical
// raw-lowercase form and from listOpenWorkItems/searchWorkItems's contract
// for reading it back.
test('closeWorkItem stores lowercase state, matching the fixture convention', () => {
  const workItems = {
    1: { number: 1, title: 'open issue', body: '', state: 'open' },
  };
  const port = createFakeProviderAdapter({ workItems });
  port.closeWorkItem(1, 'done');
  assert.equal(workItems[1].state, 'closed');
});

// #2267 additions below.

test('listBranchRules and getBranchProtection default to not-found for an absent fixture key', () => {
  const port = createFakeProviderAdapter({});
  assert.deepEqual(port.listBranchRules('o', 'r', 'main'), {
    outcome: 'not-found',
  });
  assert.deepEqual(port.getBranchProtection('o', 'r', 'main'), {
    outcome: 'not-found',
  });
});

test('mergeChangeRequest and mergeChangeRequestAtRepo record distinct owner/repo/admin flags', () => {
  const fixture: Parameters<typeof createFakeProviderAdapter>[0] = {
    locator: { provider: 'github', owner: 'ambient', name: 'repo' },
  };
  const port = createFakeProviderAdapter(fixture);
  port.mergeChangeRequest(1, 'sha1');
  port.mergeChangeRequestAdmin(2, 'sha2');
  port.mergeChangeRequestAtRepo('other', 'repo2', 3, 'sha3');
  assert.deepEqual(fixture.mergedChangeRequestCalls, [
    {
      owner: 'ambient',
      repo: 'repo',
      number: 1,
      headSha: 'sha1',
      admin: false,
    },
    { owner: 'ambient', repo: 'repo', number: 2, headSha: 'sha2', admin: true },
    { owner: 'other', repo: 'repo2', number: 3, headSha: 'sha3', admin: false },
  ]);
});

test('resolveChangeRequestReviewThread throws for a thread id in unresolvableReviewThreadIds, otherwise records it', () => {
  const fixture: Parameters<typeof createFakeProviderAdapter>[0] = {
    unresolvableReviewThreadIds: new Set(['T_stuck']),
  };
  const port = createFakeProviderAdapter(fixture);
  assert.throws(() => port.resolveChangeRequestReviewThread('T_stuck'));
  port.resolveChangeRequestReviewThread('T_ok');
  assert.deepEqual(fixture.resolvedReviewThreadIds, ['T_ok']);
});

test('listCapabilityDeclarations defaults to every group supported, matching the GitHub adapter posture', () => {
  const port = createFakeProviderAdapter({});
  const declarations = port.listCapabilityDeclarations();
  assert.equal(declarations.length, 11);
  assert.ok(
    declarations.every((declaration) => declaration.supported === true),
  );
  const advisoryReview = declarations.find(
    (declaration) => declaration.group === 'advisory-review',
  );
  assert.equal(advisoryReview?.requirement, 'optional');
});

test('listCapabilityDeclarations honors a fixture override simulating a provider without advisory review', () => {
  const port = createFakeProviderAdapter({
    capabilityDeclarations: [
      { group: 'advisory-review', requirement: 'optional', supported: false },
    ],
  });
  assert.deepEqual(port.listCapabilityDeclarations(), [
    { group: 'advisory-review', requirement: 'optional', supported: false },
  ]);
});

// resolveViewerLoginSafeQuiet / listMergedChangeRequests (Copilot review,
// PR #2429): both diverged from the GitHub adapter's own behavior in code
// the fake adapter's own suite otherwise never exercised, which could let
// a collection-wiring test pass against unrealistic fake-provider output.
test('resolveViewerLoginSafeQuiet normalizes a fixture login, matching the GitHub adapter', () => {
  const port = createFakeProviderAdapter({
    viewerLogin: '  Some-User  ',
  });
  assert.deepEqual(port.resolveViewerLoginSafeQuiet(), {
    viewerLogin: 'some-user',
    viewerLoginUnavailable: false,
  });
});

test('listMergedChangeRequests honors both limit and sinceDate, matching the GitHub adapter', () => {
  const port = createFakeProviderAdapter({
    mergedChangeRequests: [
      { number: 1, mergedAt: '2026-01-01T00:00:00Z' },
      { number: 2, mergedAt: '2026-02-01T00:00:00Z' },
      { number: 3, mergedAt: '2026-03-01T00:00:00Z' },
    ],
  });
  assert.deepEqual(
    port.listMergedChangeRequests(2, null).map((row) => row.number),
    [1, 2],
  );
  assert.deepEqual(
    port.listMergedChangeRequests(10, '2026-02-01').map((row) => row.number),
    [2, 3],
  );
});

// getWorkflowRun / listWorkflowRuns / getRepositoryDefaultBranch /
// getChangeRequestReviewsWithHeadCommitDate (Copilot review, PR #2429,
// rounds 2-3): the same fail-open-instead-of-throw and ignored-parameter
// gaps, caught by sweeping every #2267-added method against the GitHub
// adapter and port declarations before pushing a third round.
test('getWorkflowRun throws on a missing fixture, matching the GitHub adapter', () => {
  const port = createFakeProviderAdapter({
    workflowRuns: { 'o/r/123': { id: 123 } },
  });
  assert.deepEqual(port.getWorkflowRun('o', 'r', 123), { id: 123 });
  assert.throws(() => port.getWorkflowRun('o', 'r', 456), /no workflow-run/);
});

test('listWorkflowRuns honors limit, matching the GitHub adapter', () => {
  const port = createFakeProviderAdapter({
    workflowRunLists: {
      'o/r/CI': [
        {
          id: '1',
          conclusion: 'success',
          status: 'completed',
          createdAt: '',
        },
        {
          id: '2',
          conclusion: 'success',
          status: 'completed',
          createdAt: '',
        },
        {
          id: '3',
          conclusion: 'success',
          status: 'completed',
          createdAt: '',
        },
      ],
    },
  });
  assert.deepEqual(
    port.listWorkflowRuns('o', 'r', 'CI', 2).map((run) => run.id),
    ['1', '2'],
  );
});

test('getRepositoryDefaultBranch accepts owner/repo, matching the port arity', () => {
  const port = createFakeProviderAdapter({ repositoryDefaultBranch: 'main' });
  assert.equal(port.getRepositoryDefaultBranch('o', 'r'), 'main');
});

test('getChangeRequestReviewsWithHeadCommitDate throws on a missing fixture, matching the GitHub adapter', () => {
  const port = createFakeProviderAdapter({
    reviewsWithHeadCommitDate: {
      42: { reviews: [], headCommittedAt: '2026-07-31T23:00:00Z' },
    },
  });
  assert.deepEqual(port.getChangeRequestReviewsWithHeadCommitDate(42), {
    reviews: [],
    headCommittedAt: '2026-07-31T23:00:00Z',
  });
  assert.throws(
    () => port.getChangeRequestReviewsWithHeadCommitDate(43),
    /no reviews\/head-commit-date/,
  );
});

test('resolveViewerAppSlugSafe trims a fixture app slug, matching the GitHub adapter', () => {
  const port = createFakeProviderAdapter({ viewerAppSlug: '  my-app  ' });
  assert.deepEqual(port.resolveViewerAppSlugSafe(), {
    appSlug: 'my-app',
    unavailable: false,
  });
});
