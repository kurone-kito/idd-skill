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
    // No-op by default so a test exercising postWorkItemComment's retry
    // path (#2460) never actually sleeps.
    sleepSync: () => {},
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
          node_id: 'IC_kwDOexample000',
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
          nodeId: 'IC_kwDOexample000',
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

test('listWorkItemComments: GitHub and fake adapters agree on lastEditedAt when includeEditState is requested (#3246)', () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghApiJson: () => [
        {
          id: 111,
          node_id: 'IC_kwDOexample000',
          body: 'hello',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:05:00Z',
          user: { login: 'claude-bot' },
        },
      ],
      ghText: () =>
        JSON.stringify({
          data: {
            nodes: [
              {
                id: 'IC_kwDOexample000',
                lastEditedAt: '2026-01-01T00:10:00Z',
              },
            ],
          },
        }),
    }),
  );
  const fakePort = createFakeProviderAdapter({
    comments: {
      500: [
        {
          id: 111,
          nodeId: 'IC_kwDOexample000',
          body: 'hello',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:05:00Z',
          authorLogin: 'claude-bot',
          lastEditedAt: '2026-01-01T00:10:00Z',
        },
      ],
    },
  });

  const githubResult = githubPort.listWorkItemComments(500, {
    includeEditState: true,
  });
  assert.equal(githubResult[0]?.lastEditedAt, '2026-01-01T00:10:00Z');
  assert.deepEqual(
    fakePort.listWorkItemComments(500, { includeEditState: true }),
    githubResult,
  );
});

test('listWorkItemComments: GitHub and fake adapters agree lastEditedAt is undefined when includeEditState is not requested (#3246)', () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghApiJson: () => [
        {
          id: 111,
          node_id: 'IC_kwDOexample000',
          body: 'hello',
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
          nodeId: 'IC_kwDOexample000',
          body: 'hello',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:05:00Z',
          authorLogin: 'claude-bot',
          // The fixture carries a value, but neither adapter must surface
          // it -- proves the fake's opt-in stripping matches the real
          // adapter's "never asked, never fetched" contract.
          lastEditedAt: '2026-01-01T00:10:00Z',
        },
      ],
    },
  });

  const githubResult = githubPort.listWorkItemComments(500);
  assert.equal(githubResult[0]?.lastEditedAt, undefined);
  assert.deepEqual(fakePort.listWorkItemComments(500), githubResult);
});

test('listWorkItemCommentsWithRetryAsync: GitHub and fake adapters agree on last_edited_at when includeEditState is requested (#3246)', async () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        if (args[1] === 'graphql') {
          return JSON.stringify({
            data: { nodes: [{ id: 'IC_1', lastEditedAt: null }] },
          });
        }
        return JSON.stringify([
          {
            id: 1,
            node_id: 'IC_1',
            body: 'hi',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            user: { login: 'kurone-kito' },
          },
        ]);
      },
    }),
  );
  const fakePort = createFakeProviderAdapter({
    traversalComments: {
      500: [
        {
          id: 1,
          node_id: 'IC_1',
          body: 'hi',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          user: { login: 'kurone-kito' },
          last_edited_at: null,
        },
      ],
    },
  });

  const githubResult = await githubPort.listWorkItemCommentsWithRetryAsync(
    500,
    { includeEditState: true },
  );
  assert.equal(
    (githubResult[0] as Record<string, unknown>).last_edited_at,
    null,
  );
  assert.deepEqual(
    await fakePort.listWorkItemCommentsWithRetryAsync(500, {
      includeEditState: true,
    }),
    githubResult,
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
                            lastEditedAt: null,
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
                            // #3246: the edited state -- proves both
                            // adapters agree on 'edited', not just 'unedited'.
                            lastEditedAt: '2026-01-01T01:05:00Z',
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
          id: 'RT_resolved',
          isResolved: true,
          comments: [
            {
              body: '**Accepted** — fixed.',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
              authorLogin: 'kurone-kito',
              pullRequestReviewId: 'PRR_1',
              lastEditedAt: null,
            },
          ],
        },
        {
          id: 'RT_open',
          isResolved: false,
          comments: [
            {
              body: 'Please fix this too.',
              createdAt: '2026-01-01T01:00:00Z',
              updatedAt: '2026-01-01T01:00:00Z',
              authorLogin: 'copilot-pull-request-reviewer',
              pullRequestReviewId: null,
              lastEditedAt: '2026-01-01T01:05:00Z',
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
  // #2696: the real GraphQL thread id must survive the port mapping --
  // downstream diagnostics (dispositionEvidence.missingThreads[].id) key
  // off this instead of falling back to a positional thread-N label.
  assert.deepEqual(
    githubResult.map((thread) => thread.id),
    ['RT_resolved', 'RT_open'],
    'the real thread id must flow through, not be dropped',
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

// kurone-kito/idd-skill#3256: `listCheckRunWorkflowPaths` had no parity
// case at all before this issue -- added alongside the new `event` field
// (kurone-kito/idd-skill#2926 shipped `workflowPath` with no parity
// coverage either). One live check-suite carrying both `workflowPath` and
// `event` through `checkSuite.workflowRun`.
test('listCheckRunWorkflowPaths: GitHub and fake adapters agree on the normalized shape, including the event field', () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              object: {
                checkSuites: {
                  nodes: [
                    {
                      workflowRun: {
                        file: {
                          path: '.github/workflows/idd-advisory-convergence.yml',
                        },
                        event: 'pull_request_target',
                      },
                      checkRuns: {
                        nodes: [
                          {
                            detailsUrl:
                              'https://github.com/o/r/actions/runs/1/job/1',
                          },
                        ],
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
    checkRunWorkflowPaths: {
      'o/r/deadbeef/idd-advisory-convergence': [
        {
          detailsUrl: 'https://github.com/o/r/actions/runs/1/job/1',
          workflowPath: '.github/workflows/idd-advisory-convergence.yml',
          event: 'pull_request_target',
        },
      ],
    },
  });

  const githubResult = githubPort.listCheckRunWorkflowPaths(
    'o',
    'r',
    'deadbeef',
    'idd-advisory-convergence',
  );
  assert.deepEqual(githubResult, [
    {
      detailsUrl: 'https://github.com/o/r/actions/runs/1/job/1',
      workflowPath: '.github/workflows/idd-advisory-convergence.yml',
      event: 'pull_request_target',
    },
  ]);
  assert.deepEqual(
    fakePort.listCheckRunWorkflowPaths(
      'o',
      'r',
      'deadbeef',
      'idd-advisory-convergence',
    ),
    githubResult,
  );
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

test('getChangeRequestHeadObservedAt: GitHub and fake adapters agree on the earliest check-suite createdAt (kurone-kito/idd-skill#3253)', () => {
  const githubPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'abc123',
                commits: {
                  nodes: [
                    {
                      commit: {
                        oid: 'abc123',
                        checkSuites: {
                          nodes: [
                            { createdAt: '2026-09-22T01:35:21Z' },
                            { createdAt: '2026-09-22T01:36:00Z' },
                          ],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
    }),
  );
  const fakePort = createFakeProviderAdapter({
    headObservedAtByChangeRequest: { 42: '2026-09-22T01:35:21Z' },
  });

  assert.equal(
    fakePort.getChangeRequestHeadObservedAt(42),
    githubPort.getChangeRequestHeadObservedAt(42),
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
