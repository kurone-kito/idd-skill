import assert from 'node:assert/strict';
import { test } from 'node:test';

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

// ---------------------------------------------------------------------------
// getWorkItem (#2266): its own doc comment in provider-port.mts promises a
// typed ProviderError on any non-404 failure -- the pre-fix implementation
// rethrew the raw gh-exec error unwrapped instead, contradicting its own
// contract and the issue's own AC4 ("provider errors normalize into the
// contract's categories"). No existing caller catches this throw at all
// (every consumer just lets it propagate, fail-closed), so nothing depended
// on the old raw shape. Found by Copilot review, #2400.
// ---------------------------------------------------------------------------

test('getWorkItem returns null on a genuine 404, unaffected by the ProviderError wrap', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghApiJson: () => {
        const error = new Error('HTTP 404') as Error & { stderr?: string };
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      },
    }),
  );
  assert.equal(port.getWorkItem(900), null);
});

test('getWorkItem throws a typed ProviderError on a non-404 failure', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghApiJson: () => {
        const error = new Error('boom') as Error & { stderr?: string };
        error.stderr = 'gh: Internal Server Error (HTTP 500)';
        throw error;
      },
    }),
  );
  assert.throws(
    () => port.getWorkItem(900),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const providerError = error as Error & {
        category?: string;
        cause?: unknown;
      };
      assert.equal(providerError.category, 'unavailable');
      assert.match(providerError.message, /HTTP 500/);
      assert.ok(providerError.cause instanceof Error);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// searchWorkItems (#2266): its own doc comment says "like listOpenWorkItems"
// -- raw REST lowercase state, deliberately not uppercased -- but the
// implementation uppercased it, diverging from that documented contract and
// from listOpenWorkItems's own behavior for the same field. Found by
// Copilot review, #2400.
// ---------------------------------------------------------------------------

test('searchWorkItems preserves REST raw lowercase state, like listOpenWorkItems', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghApiJson: () => ({
        items: [{ number: 900, title: 'issue 900', state: 'open' }],
      }),
    }),
  );
  const [item] = port.searchWorkItems('some query');
  assert.equal(item.state, 'open');
});

// ---------------------------------------------------------------------------
// listRequiredChecks (#2266): the pre-migration ghJson/
// recoverJsonFromGhFailure recovery this method replaces, verified through
// the injectable deps seam (both recoveries have zero coverage otherwise --
// an earlier draft of this method had neither and would have thrown on both
// routine cases).
// ---------------------------------------------------------------------------

test('listRequiredChecks recovers an empty set when gh reports no required checks', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        const error = new Error('gh failed') as Error & { stderr?: string };
        error.stderr = "no required checks reported on the 'main' branch";
        throw error;
      },
    }),
  );
  assert.deepEqual(port.listRequiredChecks(42), []);
});

test('listRequiredChecks recovers from a non-zero exit that still emitted JSON on stdout', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        const error = new Error('gh failed') as Error & {
          stderr?: string;
          stdout?: string;
        };
        error.stderr = 'some checks are still pending';
        error.stdout = JSON.stringify([
          { name: 'ci', state: 'IN_PROGRESS', completedAt: null },
        ]);
        throw error;
      },
    }),
  );
  assert.deepEqual(port.listRequiredChecks(42), [
    { name: 'ci', state: 'IN_PROGRESS', completedAt: null },
  ]);
});

test('listRequiredChecks rethrows when neither recovery applies', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        const error = new Error('gh failed') as Error & { stderr?: string };
        error.stderr = 'authentication required';
        throw error;
      },
    }),
  );
  assert.throws(() => port.listRequiredChecks(42), /gh failed/);
});

// ---------------------------------------------------------------------------
// listChangeRequestReviewThreads (#2266): full-walk pagination and the
// missing-endCursor fail-fast, both preserved from
// resume-route-selection.mts's pre-migration fetchReviewThreads loop.
// ---------------------------------------------------------------------------

test('listChangeRequestReviewThreads walks every page and flattens isResolved', () => {
  const pages = [
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: true }, { isResolved: false }],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          },
        },
      },
    }),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: null }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }),
  ];
  let call = 0;
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        const page = pages[call];
        call += 1;
        return page;
      },
    }),
  );
  assert.deepEqual(port.listChangeRequestReviewThreads(7), [
    { isResolved: true },
    { isResolved: false },
    { isResolved: null },
  ]);
  assert.equal(call, 2);
});

test('listChangeRequestReviewThreads throws when hasNextPage is true but endCursor is missing', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: null },
                },
              },
            },
          },
        }),
    }),
  );
  assert.throws(
    () => port.listChangeRequestReviewThreads(7),
    /missing endCursor/,
  );
});

// ---------------------------------------------------------------------------
// resolveViewerLoginSafe (#2266): idd-roadmap-audit-execute.mts's own
// resolveViewerLogin/fetchViewerLogin (#1396) is deleted in favor of this
// method, now its sole consumer -- these three cases are moved, not new.
// ---------------------------------------------------------------------------

test('resolveViewerLoginSafe normalizes a successful login to lowercase', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({ ghText: () => 'Some-User' }),
  );
  assert.deepEqual(port.resolveViewerLoginSafe(), {
    viewerLogin: 'some-user',
    viewerLoginUnavailable: false,
  });
});

test('resolveViewerLoginSafe reports unavailable when ghText throws', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        throw new Error('gh failed');
      },
    }),
  );
  assert.deepEqual(port.resolveViewerLoginSafe(), {
    viewerLogin: '',
    viewerLoginUnavailable: true,
  });
});

test('resolveViewerLoginSafe reports unavailable on a blank-but-successful response', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({ ghText: () => '   ' }),
  );
  assert.deepEqual(port.resolveViewerLoginSafe(), {
    viewerLogin: '',
    viewerLoginUnavailable: true,
  });
});

// ---------------------------------------------------------------------------
// getWorkItemClosingPullRequestsPage / getConnectedPullRequestEventsPage
// (#2266): idd-roadmap-audit-execute.mts's hasOpenClosingPr/
// hasOpenConnectedPr distinguished an absent issue node from an absent
// connection on an otherwise-present issue -- both funnel through the same
// optional chain here, so both are covered.
// ---------------------------------------------------------------------------

test('getWorkItemClosingPullRequestsPage returns a normal page', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [{ state: 'OPEN' }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
    }),
  );
  assert.deepEqual(port.getWorkItemClosingPullRequestsPage(1048, null), {
    nodes: [{ state: 'OPEN' }],
    hasNextPage: false,
    endCursor: null,
  });
});

test('getWorkItemClosingPullRequestsPage throws when the issue node is null/absent', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => JSON.stringify({ data: { repository: { issue: null } } }),
    }),
  );
  assert.throws(
    () => port.getWorkItemClosingPullRequestsPage(1048, null),
    /connection is null\/absent/,
  );
});

test('getWorkItemClosingPullRequestsPage throws when the connection itself is null/absent', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              issue: { closedByPullRequestsReferences: null },
            },
          },
        }),
    }),
  );
  assert.throws(
    () => port.getWorkItemClosingPullRequestsPage(1048, null),
    /connection is null\/absent/,
  );
});

test('getConnectedPullRequestEventsPage returns a normal page', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              issue: {
                timelineItems: {
                  nodes: [{ __typename: 'ConnectedEvent' }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
    }),
  );
  assert.deepEqual(port.getConnectedPullRequestEventsPage(1048, null), {
    events: [{ __typename: 'ConnectedEvent' }],
    hasNextPage: false,
    endCursor: null,
  });
});

test('getConnectedPullRequestEventsPage throws when the issue node is null/absent', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => JSON.stringify({ data: { repository: { issue: null } } }),
    }),
  );
  assert.throws(
    () => port.getConnectedPullRequestEventsPage(1048, null),
    /connection is null\/absent/,
  );
});

test('getConnectedPullRequestEventsPage throws when the connection itself is null/absent', () => {
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              issue: { timelineItems: null },
            },
          },
        }),
    }),
  );
  assert.throws(
    () => port.getConnectedPullRequestEventsPage(1048, null),
    /connection is null\/absent/,
  );
});

// ---------------------------------------------------------------------------
// getWorkItemForTraversalAsync (#2266): the bounded-retry (#1394) and
// no-retry-on-404/inaccessible classification discover-roadmap-graph.mts's
// pre-migration buildIssueLoader implemented locally, moved here since the
// guard bans importing withBoundedRetry into a migrated domain file.
// ---------------------------------------------------------------------------

// The load-bearing #1394 regression guard: gh itself exits cleanly but the
// captured stdout is cut short, so the failure surfaces as a JSON.parse
// throw on a RESOLVED string, not a thrown transport error. Faithful port
// of the pre-migration buildIssueLoader fixture -- parsing outside the
// retry task would let this SyntaxError escape uncaught.
test('getWorkItemForTraversalAsync retries once past a truncated-but-resolved response, then succeeds', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        if (calls === 1) {
          return '{"number": 900, "tit';
        }
        return JSON.stringify({ number: 900, title: 'issue 900' });
      },
    }),
  );
  const result = await port.getWorkItemForTraversalAsync(900);
  assert.deepEqual(result, {
    outcome: 'found',
    item: { number: 900, title: 'issue 900' },
  });
  assert.equal(calls, 2);
});

test('getWorkItemForTraversalAsync retries once past a thrown transient transport failure, then succeeds', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error('truncated') as Error & { stderr?: string };
          error.stderr = 'unexpected end of JSON input';
          throw error;
        }
        return JSON.stringify({ number: 900, title: 'issue 900' });
      },
    }),
  );
  const result = await port.getWorkItemForTraversalAsync(900);
  assert.deepEqual(result, {
    outcome: 'found',
    item: { number: 900, title: 'issue 900' },
  });
  assert.equal(calls, 2);
});

test('getWorkItemForTraversalAsync rethrows after exhausting bounded attempts on a persistent failure', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        const error = new Error('HTTP 500') as Error & { stderr?: string };
        error.stderr = 'HTTP 500 (simulated persistent failure)';
        throw error;
      },
    }),
  );
  await assert.rejects(
    () => port.getWorkItemForTraversalAsync(900),
    /HTTP 500/,
  );
  assert.equal(calls, 3);
});

test('getWorkItemForTraversalAsync resolves not-found on a 404 immediately, without retry', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        const error = new Error('HTTP 404') as Error & { stderr?: string };
        error.stderr =
          'HTTP 404: Not Found (https://api.github.com/repos/o/r/issues/900)';
        throw error;
      },
    }),
  );
  const result = await port.getWorkItemForTraversalAsync(900);
  assert.deepEqual(result, { outcome: 'not-found' });
  assert.equal(calls, 1);
});

test('getWorkItemForTraversalAsync resolves inaccessible on a 403 immediately, without retry', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        const error = new Error('HTTP 403') as Error & { status?: number };
        error.status = 403;
        throw error;
      },
    }),
  );
  const result = await port.getWorkItemForTraversalAsync(900);
  assert.deepEqual(result, { outcome: 'inaccessible' });
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// listWorkItemSubIssueNodesAsync (#2266)
// ---------------------------------------------------------------------------

test('listWorkItemSubIssueNodesAsync retries once past a transient GraphQL failure, then succeeds', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        if (calls === 1) {
          return '{"data": {"repository": {"issue": {"sub';
        }
        return JSON.stringify({
          data: {
            repository: {
              issue: {
                subIssues: {
                  nodes: [{ number: 701 }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    }),
  );
  const result = await port.listWorkItemSubIssueNodesAsync(700);
  assert.deepEqual(result, [{ number: 701 }]);
  assert.equal(calls, 2);
});

test('listWorkItemSubIssueNodesAsync rethrows after exhausting bounded attempts on a persistent failure', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () => {
        calls += 1;
        throw new Error('rate limited (simulated persistent failure)');
      },
    }),
  );
  await assert.rejects(
    () => port.listWorkItemSubIssueNodesAsync(700),
    /rate limited/,
  );
  assert.equal(calls, 3);
});

test('listWorkItemSubIssueNodesAsync throws when the subIssues connection is missing', async () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () =>
        JSON.stringify({ data: { repository: { issue: {} } } }),
    }),
  );
  await assert.rejects(
    () => port.listWorkItemSubIssueNodesAsync(700),
    /subIssues connection missing/,
  );
});

test('listWorkItemSubIssueNodesAsync throws on a truncated page (hasNextPage, no endCursor)', async () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghTextAsync: async () =>
        JSON.stringify({
          data: {
            repository: {
              issue: {
                subIssues: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: null },
                },
              },
            },
          },
        }),
    }),
  );
  await assert.rejects(
    () => port.listWorkItemSubIssueNodesAsync(700),
    /pagination cursor missing/,
  );
});

// ---------------------------------------------------------------------------
// listWorkItemCommentsWithRetryAsync (#2266)
// ---------------------------------------------------------------------------

test('listWorkItemCommentsWithRetryAsync retries once past a transient page-fetch failure, then succeeds', async () => {
  let calls = 0;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        calls += 1;
        if (calls === 1) {
          return '[{"body": "trunca';
        }
        return JSON.stringify([
          {
            body: 'hello',
            created_at: '2026-01-01T00:00:00Z',
            user: { login: 'kurone-kito' },
          },
        ]);
      },
    }),
  );
  const result = await port.listWorkItemCommentsWithRetryAsync(900);
  assert.deepEqual(result, [
    {
      body: 'hello',
      created_at: '2026-01-01T00:00:00Z',
      user: { login: 'kurone-kito' },
    },
  ]);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// searchOpenWorkItems (#2266): discover-roadmap-graph.mts's
// buildSearchIssuesRunner, previously never directly tested (only exercised
// through live production wiring) -- net-new coverage.
// ---------------------------------------------------------------------------

test('searchOpenWorkItems builds the label-search args and returns the raw array', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return JSON.stringify([{ number: 5 }]);
      },
    }),
  );
  const result = port.searchOpenWorkItems({
    label: 'roadmap',
    fields: ['number'],
    limit: 1000,
  });
  assert.deepEqual(result, [{ number: 5 }]);
  assert.deepEqual(capturedArgs, [
    'search',
    'issues',
    '--repo',
    'o/r',
    '--state',
    'open',
    '--limit',
    '1000',
    '--json',
    'number',
    '--label',
    'roadmap',
  ]);
});

test('searchOpenWorkItems builds the body-marker-search args', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return '[]';
      },
    }),
  );
  port.searchOpenWorkItems({
    matchBody: 'idd-skill-roadmap-id',
    fields: ['number', 'body'],
    limit: 1000,
  });
  assert.deepEqual(capturedArgs, [
    'search',
    'issues',
    '--repo',
    'o/r',
    '--state',
    'open',
    '--limit',
    '1000',
    '--json',
    'number,body',
    '--match',
    'body',
    'idd-skill-roadmap-id',
  ]);
});

// ---------------------------------------------------------------------------
// #2267 additions below.
// ---------------------------------------------------------------------------

test('listChangeRequestReviewThreadCommentIds walks outer thread pages AND inner per-thread comment continuation', () => {
  const outerPages = [
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'thread-1',
                  isResolved: false,
                  comments: {
                    nodes: [{ databaseId: 101 }],
                    pageInfo: { hasNextPage: true, endCursor: 'c-101' },
                  },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'outer-1' },
            },
          },
        },
      },
    }),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'thread-2',
                  isResolved: true,
                  comments: {
                    nodes: [{ databaseId: 201 }],
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
  ];
  const continuationPage = JSON.stringify({
    data: {
      node: {
        comments: {
          nodes: [{ databaseId: 102 }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  });
  const calls: string[][] = [];
  let outerCall = 0;
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: (args) => {
        calls.push(args);
        if (args.some((arg) => arg.startsWith('query=query($id:ID!'))) {
          return continuationPage;
        }
        const page = outerPages[outerCall];
        outerCall += 1;
        return page;
      },
    }),
  );
  assert.deepEqual(port.listChangeRequestReviewThreadCommentIds(7), [
    { threadId: 'thread-1', isResolved: false, commentDatabaseIds: [101, 102] },
    { threadId: 'thread-2', isResolved: true, commentDatabaseIds: [201] },
  ]);
  // Call order: outer page 1 (thread-1) -> thread-1's comment continuation
  // (issued immediately while processing that node, before the outer loop
  // moves on) -> outer page 2 (thread-2).
  assert.equal(calls.length, 3);
  assert.ok(calls[1].some((arg) => arg === 'id=thread-1'));
  assert.ok(calls[1].some((arg) => arg === 'cursor=c-101'));
});

test('listChangeRequestReviewThreadsWithComments and listChangeRequestReviewThreadsExtended select distinct comment fragments', () => {
  const capturedQueries: string[] = [];
  const singlePage = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 't1',
                isResolved: true,
                path: 'src/foo.mts',
                comments: {
                  nodes: [
                    {
                      body: 'hello',
                      url: 'https://example.invalid/c/1',
                      createdAt: '2026-01-01T00:00:00Z',
                      updatedAt: '2026-01-01T00:00:00Z',
                      author: { login: 'reviewer' },
                      pullRequestReview: { id: 'PRR_1' },
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
  });
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: (args) => {
        const queryArg = args.find((arg) =>
          arg.startsWith('query=query($owner'),
        );
        if (queryArg) capturedQueries.push(queryArg);
        return singlePage;
      },
    }),
  );
  assert.deepEqual(port.listChangeRequestReviewThreadsWithComments(7), [
    {
      isResolved: true,
      comments: [
        {
          body: 'hello',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          authorLogin: 'reviewer',
          pullRequestReviewId: 'PRR_1',
        },
      ],
    },
  ]);
  assert.deepEqual(port.listChangeRequestReviewThreadsExtended(7), [
    {
      isResolved: true,
      path: 'src/foo.mts',
      comments: [
        {
          body: 'hello',
          url: 'https://example.invalid/c/1',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          authorLogin: 'reviewer',
        },
      ],
    },
  ]);
  assert.equal(capturedQueries.length, 2);
  assert.notEqual(capturedQueries[0], capturedQueries[1]);
  assert.match(capturedQueries[0], /pullRequestReview \{ id \}/);
  assert.doesNotMatch(capturedQueries[1], /pullRequestReview/);
});

test('listBranchRules resolves not-found on a 404 and rethrows any other failure', () => {
  const notFoundPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghApiJson: () => {
        const error = new Error('HTTP 404') as Error & { stderr?: string };
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      },
    }),
  );
  assert.deepEqual(notFoundPort.listBranchRules('o', 'r', 'main'), {
    outcome: 'not-found',
  });

  const failurePort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghApiJson: () => {
        const error = new Error('boom') as Error & { stderr?: string };
        error.stderr = 'gh: Forbidden (HTTP 403)';
        throw error;
      },
    }),
  );
  assert.throws(() => failurePort.listBranchRules('o', 'r', 'main'), /boom/);
});

test('getBranchProtection resolves ok with the raw payload on success', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghApiJson: () => ({ required_status_checks: null }),
    }),
  );
  assert.deepEqual(port.getBranchProtection('o', 'r', 'main'), {
    outcome: 'ok',
    value: { required_status_checks: null },
  });
});

test('getRepositoryFileContentAtRef resolves not-found on a 404 and ok with the raw content otherwise', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => 'YmFzZTY0',
    }),
  );
  assert.deepEqual(
    port.getRepositoryFileContentAtRef(
      'other-owner/other-repo',
      '.github/idd/config.json',
      'deadbeef',
    ),
    { outcome: 'ok', value: 'YmFzZTY0' },
  );

  const notFoundPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        const error = new Error('HTTP 404') as Error & { stderr?: string };
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      },
    }),
  );
  assert.deepEqual(
    notFoundPort.getRepositoryFileContentAtRef('o/r', 'x', 'y'),
    { outcome: 'not-found' },
  );
});

test('getMergedChangeRequestMeta returns null when the PR is not merged, and the parsed meta when it is', () => {
  const notMergedPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: { repository: { pullRequest: { merged: false } } },
        }),
    }),
  );
  assert.equal(notMergedPort.getMergedChangeRequestMeta(9), null);

  const mergedPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 9,
                merged: true,
                mergedAt: '2026-01-01T00:00:00Z',
                mergeCommit: { oid: 'deadbeef' },
              },
            },
          },
        }),
    }),
  );
  assert.deepEqual(mergedPort.getMergedChangeRequestMeta(9), {
    number: 9,
    merged: true,
    mergedAt: '2026-01-01T00:00:00Z',
    mergeCommitOid: 'deadbeef',
  });
});

test('postReviewCommentReply POSTs to the PR-scoped comment-reply endpoint (regression guard: the PR number segment was dropped in an earlier draft)', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return JSON.stringify({ id: 555 });
      },
    }),
  );
  const result = port.postReviewCommentReply(42, 99, '**Accepted** -- done.');
  assert.deepEqual(result, { id: 555 });
  assert.ok(
    capturedArgs?.includes('repos/o/r/pulls/42/comments/99/replies'),
    `expected the PR number (42) in the reply path, got: ${capturedArgs?.join(' ')}`,
  );
});

test('resolveChangeRequestReviewThread throws unless GitHub confirms isResolved', () => {
  const okPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: { resolveReviewThread: { thread: { isResolved: true } } },
        }),
    }),
  );
  assert.doesNotThrow(() => okPort.resolveChangeRequestReviewThread('T_1'));

  const unconfirmedPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: { resolveReviewThread: { thread: { isResolved: false } } },
        }),
    }),
  );
  assert.throws(
    () => unconfirmedPort.resolveChangeRequestReviewThread('T_1'),
    /did not confirm/,
  );
});

test('mergeChangeRequest and mergeChangeRequestAdmin build distinct arg shapes (--admin only on the admin variant)', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return 'merged';
      },
    }),
  );
  port.mergeChangeRequest(42, 'deadbeef');
  assert.deepEqual(capturedArgs, [
    'pr',
    'merge',
    '42',
    '-R',
    'o/r',
    '--merge',
    '--match-head-commit',
    'deadbeef',
  ]);
  port.mergeChangeRequestAdmin(42, 'deadbeef');
  assert.deepEqual(capturedArgs, [
    'pr',
    'merge',
    '42',
    '-R',
    'o/r',
    '--merge',
    '--match-head-commit',
    'deadbeef',
    '--admin',
  ]);
});

test('mergeChangeRequestAtRepo targets an explicit owner/repo distinct from the port locator', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'ambient-owner',
    'ambient-repo',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return 'merged';
      },
    }),
  );
  port.mergeChangeRequestAtRepo('other-owner', 'other-repo', 42, 'deadbeef');
  assert.deepEqual(capturedArgs, [
    'pr',
    'merge',
    '42',
    '-R',
    'other-owner/other-repo',
    '--merge',
    '--match-head-commit',
    'deadbeef',
  ]);
});

test('listChangeRequestChecks omits --required, unlike listRequiredChecks', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return '[]';
      },
    }),
  );
  port.listChangeRequestChecks(7);
  assert.ok(capturedArgs);
  assert.ok(!capturedArgs?.includes('--required'));
});

test('getChangeRequestRequestedReviewerLoginsGraphql never throws, returning null on any failure', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        throw new Error('boom');
      },
    }),
  );
  assert.equal(port.getChangeRequestRequestedReviewerLoginsGraphql(7), null);
});

test('getChangeRequestReadinessSnapshot maps all nine fields from a single pr view call', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return JSON.stringify({
          headRefOid: 'deadbeef',
          baseRefName: 'main',
          url: 'https://example.invalid/pull/7',
          author: { login: 'contributor' },
          reviewDecision: 'APPROVED',
          statusCheckRollup: [{ name: 'ci', state: 'SUCCESS' }],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          closingIssuesReferences: { nodes: [] },
        });
      },
    }),
  );
  assert.deepEqual(port.getChangeRequestReadinessSnapshot(7), {
    headSha: 'deadbeef',
    baseRefName: 'main',
    url: 'https://example.invalid/pull/7',
    authorLogin: 'contributor',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ name: 'ci', state: 'SUCCESS' }],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    closingIssuesReferences: { nodes: [] },
  });
  assert.ok(capturedArgs?.includes('-R'));
  assert.ok(
    capturedArgs?.includes(
      'headRefOid,baseRefName,url,author,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,closingIssuesReferences',
    ),
  );
});

test('getChangeRequestReviewsWithHeadCommitDate paginates reviews and fetches headCommittedAt once', () => {
  const pages = [
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: {
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              nodes: [
                {
                  id: 'PRR_1',
                  commit: { oid: 'deadbeef' },
                  submittedAt: '2026-01-01T00:00:00Z',
                  author: { login: 'copilot', __typename: 'Bot' },
                  comments: { totalCount: 2 },
                  body: 'first page review',
                },
              ],
            },
            commits: {
              nodes: [{ commit: { committedDate: '2026-01-01T00:00:00Z' } }],
            },
          },
        },
      },
    }),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'PRR_2',
                  commit: { oid: 'deadbeef' },
                  submittedAt: '2026-01-02T00:00:00Z',
                  author: { login: 'copilot', __typename: 'Bot' },
                  comments: { totalCount: 0 },
                  body: null,
                },
              ],
            },
            // Deliberately omitted on the second page -- headCommittedAt
            // must be captured once, from the first page, not overwritten
            // (or blanked) by a later page that lacks it.
            commits: { nodes: [] },
          },
        },
      },
    }),
  ];
  let call = 0;
  const port = createGithubProviderAdapter(
    'kurone-kito',
    'idd-skill',
    fakeDeps({
      ghText: () => {
        const page = pages[call];
        call += 1;
        return page;
      },
    }),
  );
  assert.deepEqual(port.getChangeRequestReviewsWithHeadCommitDate(7), {
    reviews: [
      {
        id: 'PRR_1',
        authorLogin: 'copilot',
        authorTypename: 'Bot',
        submittedAt: '2026-01-01T00:00:00Z',
        commitId: 'deadbeef',
        commentCount: 2,
        body: 'first page review',
      },
      {
        id: 'PRR_2',
        authorLogin: 'copilot',
        authorTypename: 'Bot',
        submittedAt: '2026-01-02T00:00:00Z',
        commitId: 'deadbeef',
        commentCount: 0,
        body: null,
      },
    ],
    headCommittedAt: '2026-01-01T00:00:00Z',
  });
  assert.equal(call, 2);
});

test('getChangeRequestAuthor maps login/__typename, and null when absent', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: { author: { login: 'octocat', __typename: 'User' } },
            },
          },
        }),
    }),
  );
  assert.deepEqual(port.getChangeRequestAuthor(7), {
    login: 'octocat',
    typename: 'User',
  });

  const absentPort = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({ data: { repository: { pullRequest: {} } } }),
    }),
  );
  assert.equal(absentPort.getChangeRequestAuthor(7), null);
});

test('listChangeRequestReviewThreadsWithAuthorType selects author.__typename, distinct from listChangeRequestReviewThreadsWithComments', () => {
  const singlePage = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 't1',
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      body: 'hi',
                      createdAt: '2026-01-01T00:00:00Z',
                      updatedAt: '2026-01-01T00:00:00Z',
                      author: { login: 'copilot', __typename: 'Bot' },
                      pullRequestReview: { id: 'PRR_1' },
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
  });
  let capturedQuery: string | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedQuery = args.find((arg) =>
          arg.startsWith('query=query($owner'),
        );
        return singlePage;
      },
    }),
  );
  assert.deepEqual(port.listChangeRequestReviewThreadsWithAuthorType(7), [
    {
      id: 't1',
      isResolved: false,
      comments: [
        {
          body: 'hi',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          authorLogin: 'copilot',
          authorTypename: 'Bot',
          pullRequestReviewId: 'PRR_1',
        },
      ],
    },
  ]);
  assert.match(capturedQuery ?? '', /author \{ login __typename \}/);
});

test('listMergedChangeRequests builds the merged pr-list args, with and without a sinceDate search filter', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return JSON.stringify([
          { number: 5, mergedAt: '2026-01-01T00:00:00Z' },
        ]);
      },
    }),
  );
  assert.deepEqual(port.listMergedChangeRequests(50, null), [
    { number: 5, mergedAt: '2026-01-01T00:00:00Z' },
  ]);
  assert.deepEqual(capturedArgs, [
    'pr',
    'list',
    '-R',
    'o/r',
    '--state',
    'merged',
    '--limit',
    '50',
    '--json',
    'number,mergedAt',
  ]);

  port.listMergedChangeRequests(50, '2026-01-01');
  assert.ok(capturedArgs?.includes('--search'));
  assert.ok(capturedArgs?.includes('merged:>=2026-01-01'));
});

test('getWorkflowRun preserves a string runId above Number.MAX_SAFE_INTEGER exactly (regression guard)', () => {
  let capturedArgs: string[] | undefined;
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: (args) => {
        capturedArgs = args;
        return '{}';
      },
    }),
  );
  port.getWorkflowRun('o', 'r', '9007199254740993');
  assert.ok(
    capturedArgs?.includes('repos/o/r/actions/runs/9007199254740993'),
    `expected the exact run id in the path, got: ${capturedArgs?.join(' ')}`,
  );
});

test('listWorkflowRuns preserves a databaseId above Number.MAX_SAFE_INTEGER exactly (Codex review, PR #2429)', () => {
  const port = createGithubProviderAdapter(
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
  const runs = port.listWorkflowRuns('o', 'r', 'CI', 10);
  assert.equal(runs[0]?.id, '9007199254740993');
});

test('listCapabilityDeclarations reports every provider-contract group supported, no network call', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => {
        throw new Error('listCapabilityDeclarations must not call gh');
      },
    }),
  );
  const declarations = port.listCapabilityDeclarations();
  assert.equal(declarations.length, 11);
  assert.ok(
    declarations.every((declaration) => declaration.supported === true),
  );
  const advisoryReview = declarations.find(
    (declaration) => declaration.group === 'advisory-review',
  );
  assert.equal(advisoryReview?.requirement, 'optional');
  const changeRequests = declarations.find(
    (declaration) => declaration.group === 'change-requests',
  );
  assert.equal(changeRequests?.requirement, 'required');
});

// ---------------------------------------------------------------------------
// GHES `--hostname` on raw `gh api graphql` calls (Codex review, PR #2429):
// gh-exec.mts's shared ghGraphql/ghApiJson helpers resolve the correct GHES
// host (#1962), but this file's paginated GraphQL methods build their own
// `gh api graphql` args by hand (a tight-loop stdin hazard, #1396) rather
// than routing through that shared helper -- several of #2267's methods
// replaced an old call path that DID resolve the host this way
// (advisory-convergence.mts's fetchPrAuthor/fetchReviewThreads,
// review-clause.mts's fetchReviewsAndHeadCommit, advisory-wait-state.mts's
// requested-reviewer query all imported gh-exec.mts's ghGraphql), so
// omitting `--hostname` here was a genuine regression for a GHES adopter.
// ---------------------------------------------------------------------------

function withGhHostEnv(
  overrides: { GH_HOST?: string; GITHUB_SERVER_URL?: string },
  run: () => void,
): void {
  const originalGhHost = process.env.GH_HOST;
  const originalServerUrl = process.env.GITHUB_SERVER_URL;
  if (overrides.GH_HOST === undefined) {
    delete process.env.GH_HOST;
  } else {
    process.env.GH_HOST = overrides.GH_HOST;
  }
  if (overrides.GITHUB_SERVER_URL === undefined) {
    delete process.env.GITHUB_SERVER_URL;
  } else {
    process.env.GITHUB_SERVER_URL = overrides.GITHUB_SERVER_URL;
  }
  try {
    run();
  } finally {
    if (originalGhHost === undefined) {
      delete process.env.GH_HOST;
    } else {
      process.env.GH_HOST = originalGhHost;
    }
    if (originalServerUrl === undefined) {
      delete process.env.GITHUB_SERVER_URL;
    } else {
      process.env.GITHUB_SERVER_URL = originalServerUrl;
    }
  }
}

test('getChangeRequestAuthor targets the resolved GHES host on a raw gh api graphql call', () => {
  withGhHostEnv({ GITHUB_SERVER_URL: 'https://ghes.example.com' }, () => {
    let capturedArgs: string[] | undefined;
    const port = createGithubProviderAdapter(
      'o',
      'r',
      fakeDeps({
        ghText: (args) => {
          capturedArgs = args;
          return JSON.stringify({ data: { repository: { pullRequest: {} } } });
        },
      }),
    );
    port.getChangeRequestAuthor(7);
    const hostnameIndex = capturedArgs?.indexOf('--hostname') ?? -1;
    assert.ok(
      hostnameIndex >= 0,
      `expected --hostname in args, got: ${capturedArgs?.join(' ')}`,
    );
    assert.equal(capturedArgs?.[hostnameIndex + 1], 'ghes.example.com');
  });
});

test('getChangeRequestAuthor omits --hostname for github.com (no regression on the common case)', () => {
  withGhHostEnv({ GITHUB_SERVER_URL: 'https://github.com' }, () => {
    let capturedArgs: string[] | undefined;
    const port = createGithubProviderAdapter(
      'o',
      'r',
      fakeDeps({
        ghText: (args) => {
          capturedArgs = args;
          return JSON.stringify({ data: { repository: { pullRequest: {} } } });
        },
      }),
    );
    port.getChangeRequestAuthor(7);
    assert.ok(!capturedArgs?.includes('--hostname'));
  });
});

test('getChangeRequestReviewsWithHeadCommitDate throws on a GraphQL errors payload instead of treating it as no evidence (CodeRabbit review, PR #2429)', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({ errors: [{ message: 'boom' }], data: null }),
    }),
  );
  assert.throws(
    () => port.getChangeRequestReviewsWithHeadCommitDate(7),
    /boom/,
  );
});

// listChangeRequestGraphqlComments / listChangeRequestGraphqlReviews
// (Codex review, PR #2429): a missing pullRequest node or connection must
// fail fast rather than silently read as zero comments/reviews, matching
// merged-pr-feedback-sweep.mts's pre-migration fetchAllNodes -- otherwise a
// transient/permission anomaly makes a PR look "clean" instead of failing
// loudly.
test('listChangeRequestGraphqlComments returns nodes on a normal payload', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                comments: {
                  nodes: [
                    {
                      body: 'hi',
                      url: 'https://example.invalid',
                      createdAt: '2026-01-01T00:00:00Z',
                      updatedAt: '2026-01-01T00:00:00Z',
                      author: { login: 'octocat' },
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
  assert.deepEqual(port.listChangeRequestGraphqlComments(7), [
    {
      body: 'hi',
      url: 'https://example.invalid',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      authorLogin: 'octocat',
    },
  ]);
});

test('listChangeRequestGraphqlComments throws on a missing pullRequest node', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => JSON.stringify({ data: { repository: {} } }),
    }),
  );
  assert.throws(
    () => port.listChangeRequestGraphqlComments(7),
    /no pullRequest node/,
  );
});

test('listChangeRequestGraphqlComments throws on a null comments connection', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: { repository: { pullRequest: { comments: null } } },
        }),
    }),
  );
  assert.throws(
    () => port.listChangeRequestGraphqlComments(7),
    /null comments connection/,
  );
});

test('listChangeRequestGraphqlReviews throws on a missing pullRequest node', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () => JSON.stringify({ data: { repository: {} } }),
    }),
  );
  assert.throws(
    () => port.listChangeRequestGraphqlReviews(7),
    /no pullRequest node/,
  );
});

test('listChangeRequestGraphqlReviews throws on a null reviews connection', () => {
  const port = createGithubProviderAdapter(
    'o',
    'r',
    fakeDeps({
      ghText: () =>
        JSON.stringify({
          data: { repository: { pullRequest: { reviews: null } } },
        }),
    }),
  );
  assert.throws(
    () => port.listChangeRequestGraphqlReviews(7),
    /null reviews connection/,
  );
});
