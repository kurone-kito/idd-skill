// #2268 AC3: GitHub-parity guard. Both `provider-adapter-github.mts` and
// `provider-adapter-fake.mts` implement the same `ProviderPort` -- the
// migrated domain helpers must see identical normalized values from either
// one for equivalent underlying state. Each test below feeds one canned raw
// gh payload through the real GitHub adapter (stubbing its injectable
// `GithubProviderAdapterDeps`, the lighter in-process mechanism
// tests/provider-adapter-github.test.mts already uses -- no subprocess, no
// PATH mock, no second harness) and an equivalent fixture through the fake
// adapter, then asserts the two returned port values are exactly
// `deepEqual`. A weakened assertion here would certify divergence as
// parity, so every field the fake supplies matches the GitHub stub's
// corresponding raw field, never a placeholder.
//
// Covers the seven areas #2268's acceptance criteria name: marker bodies,
// issue selection, review disposition, check state, freshness, unresolved
// threads, and merge readiness.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';
import {
  createGithubProviderAdapter,
  type GithubProviderAdapterDeps,
} from '../src/scripts/provider-adapter-github.mts';

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
    ...overrides,
  } as GithubProviderAdapterDeps;
}

// --- issue selection ---------------------------------------------------

test('getWorkItem: GitHub and fake adapters agree on the normalized shape', () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghApiJson: () => ({
        number: 500,
        title: 'Fix bug',
        body: 'desc',
        state: 'open',
        labels: [{ name: 'bug' }],
        url: 'https://api.github.com/repos/o/r/issues/500',
        html_url: 'https://github.com/o/r/issues/500',
        milestone: null,
        user: { login: 'alice' },
        author_association: 'OWNER',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      }),
    }),
  );
  const fakePort = createFakeProviderAdapter({
    workItems: {
      500: {
        number: 500,
        title: 'Fix bug',
        body: 'desc',
        state: 'open',
        labels: [{ name: 'bug' }],
        url: 'https://api.github.com/repos/o/r/issues/500',
        htmlUrl: 'https://github.com/o/r/issues/500',
        milestone: null,
        user: { login: 'alice' },
        authorAssociation: 'OWNER',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    },
  });

  const githubResult = githubPort.getWorkItem(500);
  const fakeResult = fakePort.getWorkItem(500);
  assert.notEqual(githubResult, null);
  // getWorkItem uppercases state on read (both adapters share this
  // contract) -- assert it explicitly before the full deepEqual so a
  // divergence there fails with a readable message.
  assert.equal(githubResult?.state, 'OPEN');
  assert.deepEqual(fakeResult, githubResult);
});

// --- marker bodies -------------------------------------------------------

test('listWorkItemComments: GitHub and fake adapters agree on the normalized shape', () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghApiJson: () => [
        {
          id: 111,
          body: '<!-- idd-skill-claimed-by: claude-1 uuid-1 supersedes: none 2026-01-01T00:00:00Z branch: issue/1 -->',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:05:00Z',
          user: { login: 'claude-bot' },
        },
      ],
    }),
  );
  const fakePort = createFakeProviderAdapter({
    comments: {
      500: [
        {
          id: 111,
          body: '<!-- idd-skill-claimed-by: claude-1 uuid-1 supersedes: none 2026-01-01T00:00:00Z branch: issue/1 -->',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:05:00Z',
          authorLogin: 'claude-bot',
        },
      ],
    },
  });

  assert.deepEqual(
    fakePort.listWorkItemComments(500),
    githubPort.listWorkItemComments(500),
  );
});

// --- review disposition + unresolved threads -----------------------------

test('listChangeRequestReviewThreadsWithComments: GitHub and fake adapters agree on the normalized shape', () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'RT_resolved',
                      isResolved: true,
                      path: 'src/x.mts',
                      comments: {
                        nodes: [
                          {
                            body: '**Accepted** — fixed.',
                            createdAt: '2026-01-01T00:00:00Z',
                            updatedAt: '2026-01-01T00:00:00Z',
                            author: { login: 'kurone-kito' },
                            pullRequestReview: { id: 'PRR_1' },
                          },
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                    {
                      id: 'RT_open',
                      isResolved: false,
                      path: 'src/y.mts',
                      comments: {
                        nodes: [
                          {
                            body: 'Please fix this too.',
                            createdAt: '2026-01-01T01:00:00Z',
                            updatedAt: '2026-01-01T01:00:00Z',
                            author: { login: 'copilot-pull-request-reviewer' },
                            pullRequestReview: null,
                          },
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
    }),
  );
  const fakePort = createFakeProviderAdapter({
    reviewThreadsWithComments: {
      42: [
        {
          isResolved: true,
          comments: [
            {
              body: '**Accepted** — fixed.',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
              authorLogin: 'kurone-kito',
              pullRequestReviewId: 'PRR_1',
            },
          ],
        },
        {
          isResolved: false,
          comments: [
            {
              body: 'Please fix this too.',
              createdAt: '2026-01-01T01:00:00Z',
              updatedAt: '2026-01-01T01:00:00Z',
              authorLogin: 'copilot-pull-request-reviewer',
              pullRequestReviewId: null,
            },
          ],
        },
      ],
    },
  });

  const githubResult =
    githubPort.listChangeRequestReviewThreadsWithComments(42);
  const fakeResult = fakePort.listChangeRequestReviewThreadsWithComments(42);
  assert.deepEqual(
    githubResult.map((thread) => thread.isResolved),
    [true, false],
    'sanity: one resolved thread, one unresolved',
  );
  assert.deepEqual(fakeResult, githubResult);
});

// --- check state -----------------------------------------------------------

test('listWorkflowRuns: GitHub and fake adapters agree on the normalized shape, precision-preserving id', () => {
  // A databaseId above Number.MAX_SAFE_INTEGER, string-preserved by both
  // adapters (#2267 AC, PR #2429 Codex review) -- encodes the exact
  // divergence point the id-stringification fix closed.
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify([
          {
            databaseId: '9007199254740993',
            conclusion: 'success',
            status: 'completed',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ]),
    }),
  );
  const fakePort = createFakeProviderAdapter({
    workflowRunLists: {
      'o/r/CI': [
        {
          id: '9007199254740993',
          conclusion: 'success',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    },
  });

  const githubResult = githubPort.listWorkflowRuns('o', 'r', 'CI', 10);
  assert.equal(githubResult[0]?.id, '9007199254740993');
  assert.deepEqual(fakePort.listWorkflowRuns('o', 'r', 'CI', 10), githubResult);
});

// --- freshness ---------------------------------------------------------

test('getChangeRequestReviewsWithHeadCommitDate: GitHub and fake adapters agree on the normalized shape', () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'PRR_1',
                      commit: { oid: 'abc123' },
                      submittedAt: '2026-01-01T02:00:00Z',
                      author: { login: 'copilot', __typename: 'Bot' },
                      comments: { totalCount: 1 },
                      body: 'LGTM with one comment.',
                    },
                  ],
                },
                commits: {
                  nodes: [
                    { commit: { committedDate: '2026-01-01T01:00:00Z' } },
                  ],
                },
              },
            },
          },
        }),
    }),
  );
  const fakePort = createFakeProviderAdapter({
    reviewsWithHeadCommitDate: {
      42: {
        reviews: [
          {
            id: 'PRR_1',
            authorLogin: 'copilot',
            authorTypename: 'Bot',
            submittedAt: '2026-01-01T02:00:00Z',
            commitId: 'abc123',
            commentCount: 1,
            body: 'LGTM with one comment.',
          },
        ],
        headCommittedAt: '2026-01-01T01:00:00Z',
      },
    },
  });

  assert.deepEqual(
    fakePort.getChangeRequestReviewsWithHeadCommitDate(42),
    githubPort.getChangeRequestReviewsWithHeadCommitDate(42),
  );
});

// --- merge readiness -----------------------------------------------------

test('getChangeRequestReadinessSnapshot: GitHub and fake adapters agree on the normalized shape', () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          headRefOid: 'deadbeef',
          baseRefName: 'main',
          url: 'https://github.com/o/r/pull/42',
          author: { login: 'author-user' },
          reviewDecision: 'APPROVED',
          statusCheckRollup: [{ name: 'lint', conclusion: 'SUCCESS' }],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          closingIssuesReferences: [{ number: 7 }],
        }),
    }),
  );
  const fakePort = createFakeProviderAdapter({
    changeRequestReadinessSnapshots: {
      42: {
        headSha: 'deadbeef',
        baseRefName: 'main',
        url: 'https://github.com/o/r/pull/42',
        authorLogin: 'author-user',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [{ name: 'lint', conclusion: 'SUCCESS' }],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [{ number: 7 }],
      },
    },
  });

  assert.deepEqual(
    fakePort.getChangeRequestReadinessSnapshot(42),
    githubPort.getChangeRequestReadinessSnapshot(42),
  );
});
